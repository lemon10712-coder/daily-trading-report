// 每日回測：拿收盤後的 data/prices.json 跟當天 data/latest.json 的進場/停利/目標/停損比對，
// 純數字計算、不靠 AI，才能每個交易日收盤後穩定自動跑。
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const PRICES_PATH = path.join(DATA_DIR, 'prices.json');
const BACKTEST_DIR = path.join(DATA_DIR, 'backtest');
const BACKTEST_LATEST_PATH = path.join(DATA_DIR, 'backtest-latest.json');

function parseRangeMid(str) {
  if (str == null) return null;
  // 股價都是正數，entry 常寫成「64.5-65.5」這種範圍，中間的 "-" 是分隔號不是負號，
  // 用不允許負號的 pattern 避免把 "-65.5" 誤判成負數、算出離譜的中點。
  const nums = String(str).replace(/,/g, '').match(/\d+(\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  const values = nums.map(Number);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function parseNum(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function evaluatePick(pick, closePrice) {
  const entryMid = parseRangeMid(pick.entry);
  const stopLoss = parseNum(pick.stop_loss);
  const takeProfit = parseNum(pick.take_profit);
  const target = parseNum(pick.target);

  if (closePrice == null || entryMid == null) {
    return { status: 'no_data', label: '無資料可比對', pct_vs_entry: null, close: closePrice ?? null, entry_mid: entryMid, stop_loss: stopLoss, take_profit: takeProfit, target };
  }

  const pct = ((closePrice - entryMid) / entryMid) * 100;
  let status, label;
  if (stopLoss != null && closePrice <= stopLoss) {
    status = 'stop_loss'; label = '❌ 觸及停損';
  } else if (target != null && closePrice >= target) {
    status = 'target'; label = '🎯 達到目標價';
  } else if (takeProfit != null && closePrice >= takeProfit) {
    status = 'take_profit'; label = '✅ 達到停利點';
  } else if (closePrice > entryMid) {
    status = 'up_no_exit'; label = '🟡 上漲但未達停利';
  } else if (closePrice < entryMid) {
    status = 'down_no_stop'; label = '🟡 拉回但未觸停損';
  } else {
    status = 'flat'; label = '⚪ 持平於進場區附近';
  }

  return {
    status, label,
    pct_vs_entry: Math.round(pct * 100) / 100,
    close: closePrice,
    entry_mid: Math.round(entryMid * 100) / 100,
    stop_loss: stopLoss, take_profit: takeProfit, target,
  };
}

function buildNarrative(result) {
  const lines = [];
  const { safe_pick, aggressive_pick } = result.picks;
  if (safe_pick) {
    lines.push(`安全牌 ${safe_pick.name}（${safe_pick.symbol}）：收盤 ${safe_pick.close ?? '無資料'}，${safe_pick.label}${safe_pick.pct_vs_entry != null ? `（較進場區中點 ${safe_pick.pct_vs_entry > 0 ? '+' : ''}${safe_pick.pct_vs_entry}%）` : ''}。`);
  }
  if (aggressive_pick) {
    lines.push(`衝最快 ${aggressive_pick.name}（${aggressive_pick.symbol}）：收盤 ${aggressive_pick.close ?? '無資料'}，${aggressive_pick.label}${aggressive_pick.pct_vs_entry != null ? `（較進場區中點 ${aggressive_pick.pct_vs_entry > 0 ? '+' : ''}${aggressive_pick.pct_vs_entry}%）` : ''}。`);
  }
  const stopCount = [safe_pick, aggressive_pick].filter(p => p && p.status === 'stop_loss').length;
  const winCount = [safe_pick, aggressive_pick].filter(p => p && (p.status === 'target' || p.status === 'take_profit')).length;
  let verdict;
  if (stopCount === 2) verdict = '兩檔正式推薦今天都觸及停損，是失準的一天。';
  else if (stopCount === 1 && winCount === 0) verdict = '一檔觸及停損、另一檔未達停利，今天整體不理想。';
  else if (winCount === 2) verdict = '兩檔正式推薦今天都達到停利／目標價，是準確的一天。';
  else if (winCount === 1 && stopCount === 0) verdict = '一檔達標、另一檔持平未觸停損，今天表現尚可。';
  else verdict = '今天結果好壞參半，詳見各檔明細。';
  lines.push(`總評：${verdict}`);
  return lines.join('\n');
}

function main() {
  if (!fs.existsSync(LATEST_PATH)) {
    console.log('No latest.json yet, skip backtest.');
    return;
  }
  const report = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));

  if (report.market_open === false) {
    console.log('Market closed today (holiday), skip backtest.');
    return;
  }

  if (!fs.existsSync(PRICES_PATH)) {
    console.log('No prices.json yet, skip backtest.');
    return;
  }
  const pricesData = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8'));
  if (pricesData.price_type !== 'close') {
    console.log(`prices.json is not close-of-day yet (price_type=${pricesData.price_type}). Skip — will retry on next scheduled run.`);
    return;
  }
  // 收盤價快照必須跟今天的報告是同一天，避免昨天的殘留資料被誤判成今天的回測結果。
  const pricesDate = (pricesData.updated_at || '').slice(0, 10);
  // updated_at 格式是 zh-TW locale 字串（例如 2026/7/17 下午5:19:24），沒有穩定的 ISO 日期可比對，
  // 這裡改用「latest.json 的 date 欄位」當唯一依據，pricesDate 僅供除錯記錄，不參與判斷。

  const prices = pricesData.prices || {};

  const result = {
    date: report.date,
    generated_at: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    price_snapshot_at: pricesData.updated_at || null,
    picks: {},
    candidates: [],
  };

  const summary = report.summary || {};
  if (summary.safe_pick) {
    const p = summary.safe_pick;
    const close = prices[p.symbol] ? prices[p.symbol].price : null;
    result.picks.safe_pick = { symbol: p.symbol, name: p.name, ...evaluatePick(p, close) };
  }
  if (summary.aggressive_pick) {
    const p = summary.aggressive_pick;
    const close = prices[p.symbol] ? prices[p.symbol].price : null;
    result.picks.aggressive_pick = { symbol: p.symbol, name: p.name, ...evaluatePick(p, close) };
  }
  (report.candidates || []).forEach((c) => {
    const close = prices[c.symbol] ? prices[c.symbol].price : null;
    result.candidates.push({ symbol: c.symbol, name: c.name, rank: c.rank, ...evaluatePick(c, close) });
  });

  result.narrative = buildNarrative(result);

  fs.writeFileSync(BACKTEST_LATEST_PATH, JSON.stringify(result, null, 2) + '\n');
  if (!fs.existsSync(BACKTEST_DIR)) fs.mkdirSync(BACKTEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKTEST_DIR, `${report.date}.json`), JSON.stringify(result, null, 2) + '\n');

  console.log('Backtest written for', report.date);
  console.log(result.narrative);
}

main();
