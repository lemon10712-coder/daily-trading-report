// Intraday-aware daily backtest. A recommendation counts only when one-minute
// bars actually touch its entry. Exits are evaluated bar-by-bar. If the same
// minute touches stop and target, use the conservative stop result.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const BACKTEST_DIR = path.join(DATA_DIR, 'backtest');
const BACKTEST_LATEST_PATH = path.join(DATA_DIR, 'backtest-latest.json');
const DEFAULT_COSTS = {
  commissionRate: Number(process.env.BACKTEST_COMMISSION_RATE || 0.001425),
  sellTaxRate: Number(process.env.BACKTEST_SELL_TAX_RATE || 0.0015),
  slippageRate: Number(process.env.BACKTEST_SLIPPAGE_RATE || 0),
};

function parseNumbers(value) {
  if (value == null) return [];
  const matches = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  return matches ? matches.map(Number).filter(Number.isFinite) : [];
}

function parseRange(value) {
  const numbers = parseNumbers(value);
  if (!numbers.length) return null;
  const selected = numbers.slice(0, 2);
  return { low: Math.min(...selected), high: Math.max(...selected) };
}

function parseNum(value) {
  return parseNumbers(value)[0] ?? null;
}

function parseEarlyStop(pick) {
  const explicit = parseNum(pick.early_stop);
  if (explicit != null) return explicit;
  const match = String(pick.plan_a || '').match(/跌破\s*([\d,.]+)\s*元?\s*先(?:減碼|出)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function taipeiDate(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function taipeiTime(timestamp) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp * 1000));
}

async function fetchYahooBarsForSymbol(symbol, date) {
  for (const suffix of ['TW', 'TWO']) {
    const yahooSymbol = `${symbol}.${suffix}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1m&events=history`;
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 CHARLES-AGENT/1.0' } });
      if (!response.ok) continue;
      const payload = await response.json();
      const result = payload?.chart?.result?.[0];
      const quote = result?.indicators?.quote?.[0];
      if (!result || !quote) continue;
      const bars = [];
      for (let index = 0; index < (result.timestamp || []).length; index += 1) {
        const timestamp = result.timestamp[index];
        const close = quote.close?.[index];
        if (taipeiDate(timestamp) !== date || !Number.isFinite(close)) continue;
        bars.push({
          time: taipeiTime(timestamp), timestamp,
          open: Number(quote.open?.[index]), high: Number(quote.high?.[index]),
          low: Number(quote.low?.[index]), close: Number(close),
          volume: Number(quote.volume?.[index] || 0),
        });
      }
      if (bars.length) return { bars, source: `Yahoo Finance ${yahooSymbol} 1m` };
    } catch (error) {
      console.error(`Minute quote failed for ${yahooSymbol}: ${error.message}`);
    }
  }
  return { bars: [], source: 'Yahoo Finance 1m unavailable' };
}

function entryFillForBar(bar, range) {
  if (!Number.isFinite(bar.low) || !Number.isFinite(bar.high)) return null;
  if (bar.high < range.low || bar.low > range.high) return null;
  const midpoint = (range.low + range.high) / 2;
  if (bar.low <= midpoint && bar.high >= midpoint) return midpoint;
  if (bar.open >= range.low && bar.open <= range.high) return bar.open;
  return Math.max(range.low, Math.min(range.high, bar.close));
}

function tradeNetPnl(entryPrice, exits, costs = DEFAULT_COSTS) {
  const averageExit = exits.reduce((sum, item) => sum + item.price * item.fraction, 0);
  const buyCost = entryPrice * costs.commissionRate;
  const sellCosts = exits.reduce((sum, item) => (
    sum + item.price * item.fraction * (costs.commissionRate + costs.sellTaxRate)
  ), 0);
  const slippage = entryPrice * costs.slippageRate
    + exits.reduce((sum, item) => sum + item.price * item.fraction * costs.slippageRate, 0);
  const grossPnl = averageExit - entryPrice;
  const netPnl = grossPnl - buyCost - sellCosts - slippage;
  return {
    averageExit,
    grossPct: (grossPnl / entryPrice) * 100,
    netPct: (netPnl / entryPrice) * 100,
    costPct: ((buyCost + sellCosts + slippage) / entryPrice) * 100,
  };
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function noTradeResult(pick, close, reason, source) {
  const range = parseRange(pick.entry);
  return {
    status: 'no_trade', label: '⚪ 未觸發進場', entry_triggered: false,
    no_trade_reason: reason, pct_vs_entry: null, gross_pct: 0, net_pct: 0,
    close: round(close), entry_mid: range ? round((range.low + range.high) / 2) : null,
    stop_loss: parseNum(pick.stop_loss), take_profit: parseNum(pick.take_profit),
    target: parseNum(pick.target), intraday_source: source,
  };
}

function evaluatePickIntraday(pick, bars, costs = DEFAULT_COSTS, source = 'fixture') {
  const range = parseRange(pick.entry);
  const closePrice = bars.length ? bars[bars.length - 1].close : null;
  if (!range || !bars.length) return noTradeResult(pick, closePrice, !range ? 'missing_entry_range' : 'missing_intraday_bars', source);

  let entryIndex = -1;
  let entryPrice = null;
  for (let index = 0; index < bars.length; index += 1) {
    const fill = entryFillForBar(bars[index], range);
    if (fill != null) { entryIndex = index; entryPrice = fill; break; }
  }
  if (entryIndex < 0) return noTradeResult(pick, closePrice, 'price_never_touched_entry', source);

  const stopLoss = parseNum(pick.stop_loss);
  const earlyStop = parseEarlyStop(pick);
  const takeProfit = parseNum(pick.take_profit);
  const target = parseNum(pick.target);
  const exits = [];
  let remaining = 1;
  let earlyStopDone = false;
  let status = 'open_at_close';
  let label = '🟡 收盤仍持有';
  let ambiguous = false;

  for (let index = entryIndex; index < bars.length && remaining > 0; index += 1) {
    const bar = bars[index];
    const stopHit = stopLoss != null && bar.low <= stopLoss;
    const earlyStopHit = !earlyStopDone && earlyStop != null && (stopLoss == null || earlyStop > stopLoss) && bar.low <= earlyStop;
    const targetHit = target != null && bar.high >= target;
    const takeProfitHit = takeProfit != null && bar.high >= takeProfit;
    if (stopHit && (targetHit || takeProfitHit)) {
      ambiguous = true;
      exits.push({ fraction: remaining, price: stopLoss, time: bar.time, reason: 'same_bar_ambiguous_stop' });
      remaining = 0; status = 'ambiguous_stop'; label = '⚠️ 同分鐘停利停損，保守採停損'; break;
    }
    if (stopHit) {
      exits.push({ fraction: remaining, price: stopLoss, time: bar.time, reason: 'stop_loss' });
      remaining = 0; status = 'stop_loss'; label = '❌ 觸及停損'; break;
    }
    if (earlyStopHit && remaining > 0.5) {
      exits.push({ fraction: 0.5, price: earlyStop, time: bar.time, reason: 'early_stop' });
      remaining -= 0.5; earlyStopDone = true;
    }
    if (targetHit) {
      exits.push({ fraction: remaining, price: target, time: bar.time, reason: 'target' });
      remaining = 0; status = 'target'; label = '🎯 達到目標價'; break;
    }
    if (takeProfitHit) {
      exits.push({ fraction: remaining, price: takeProfit, time: bar.time, reason: 'take_profit' });
      remaining = 0; status = 'take_profit'; label = '✅ 達到停利點'; break;
    }
  }

  if (remaining > 0) {
    exits.push({ fraction: remaining, price: closePrice, time: bars[bars.length - 1].time, reason: 'close' });
    const gross = (closePrice - entryPrice) / entryPrice;
    status = gross > 0 ? 'up_no_exit' : gross < 0 ? 'down_no_stop' : 'flat';
    label = gross > 0 ? '🟡 上漲但未達停利' : gross < 0 ? '🟠 下跌但未達停損' : '⚪ 平盤';
  }

  const pnl = tradeNetPnl(entryPrice, exits, costs);
  return {
    status, label, entry_triggered: true, entry_time: bars[entryIndex].time,
    entry_price: round(entryPrice), exit_time: exits.at(-1)?.time || null,
    average_exit: round(pnl.averageExit),
    exits: exits.map((item) => ({ ...item, price: round(item.price), fraction: round(item.fraction, 4) })),
    ambiguous, pct_vs_entry: round(pnl.grossPct), gross_pct: round(pnl.grossPct),
    net_pct: round(pnl.netPct), transaction_cost_pct: round(pnl.costPct),
    close: round(closePrice), entry_mid: round((range.low + range.high) / 2),
    stop_loss: stopLoss, early_stop: earlyStop, take_profit: takeProfit, target,
    intraday_source: source,
  };
}

function buildNarrative(result) {
  const picks = Object.values(result.picks || {}).filter(Boolean);
  const triggered = picks.filter((item) => item.entry_triggered);
  const wins = triggered.filter((item) => ['target', 'take_profit', 'up_no_exit'].includes(item.status));
  const losses = triggered.filter((item) => ['stop_loss', 'ambiguous_stop', 'down_no_stop'].includes(item.status));
  const noTrades = picks.filter((item) => !item.entry_triggered);
  const lines = picks.map((item) => `${item.name}（${item.symbol}）：${item.label}${item.entry_triggered ? `，淨報酬 ${item.net_pct}%` : ''}`);
  lines.push(`總評：推薦 ${picks.length} 檔，實際觸發 ${triggered.length} 檔，未進場 ${noTrades.length} 檔；獲利 ${wins.length}、虧損 ${losses.length}。`);
  return lines.join('\n');
}

async function evaluateNamedPick(pick, date) {
  if (!pick?.symbol) return null;
  const { bars, source } = await fetchYahooBarsForSymbol(pick.symbol, date);
  return { symbol: pick.symbol, name: pick.name, ...evaluatePickIntraday(pick, bars, DEFAULT_COSTS, source) };
}

async function main() {
  if (!fs.existsSync(LATEST_PATH)) { console.log('No latest.json yet, skip backtest.'); return; }
  const report = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
  if (report.market_open === false) { console.log('Market closed today (holiday), skip backtest.'); return; }
  if (process.env.FORCE_BACKTEST !== '1' && fs.existsSync(BACKTEST_LATEST_PATH)) {
    const existing = JSON.parse(fs.readFileSync(BACKTEST_LATEST_PATH, 'utf8'));
    const existingPicks = Object.values(existing.picks || {}).filter(Boolean);
    const isComplete = existing.date === report.date
      && Number(existing.schema_version) >= 2
      && existingPicks.length > 0
      && existingPicks.every((item) => !String(item.intraday_source || '').includes('unavailable'));
    if (isComplete) {
      console.log(`Schema v2 backtest for ${report.date} is already complete; skip duplicate run.`);
      return;
    }
  }
  const result = {
    schema_version: 2,
    methodology: 'one-minute entry/exit sequence; same-bar ambiguity uses conservative stop',
    date: report.date,
    generated_at: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    price_snapshot_at: null,
    cost_assumptions: DEFAULT_COSTS,
    picks: {}, candidates: [],
  };
  const summary = report.summary || {};
  if (summary.safe_pick) result.picks.safe_pick = await evaluateNamedPick(summary.safe_pick, report.date);
  if (summary.aggressive_pick) result.picks.aggressive_pick = await evaluateNamedPick(summary.aggressive_pick, report.date);
  for (const candidate of report.candidates || []) result.candidates.push(await evaluateNamedPick(candidate, report.date));
  result.price_snapshot_at = result.picks.safe_pick?.intraday_source || result.picks.aggressive_pick?.intraday_source || null;
  result.narrative = buildNarrative(result);
  if (!fs.existsSync(BACKTEST_DIR)) fs.mkdirSync(BACKTEST_DIR, { recursive: true });
  fs.writeFileSync(BACKTEST_LATEST_PATH, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(BACKTEST_DIR, `${report.date}.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log('Backtest written for', report.date);
  console.log(result.narrative);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { parseRange, parseEarlyStop, entryFillForBar, evaluatePickIntraday, tradeNetPnl, buildNarrative };
