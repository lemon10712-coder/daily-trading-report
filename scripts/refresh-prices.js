// Fetch live quotes for symbols listed in data/latest.json. Three tiers:
// 1) TWSE's free MIS quote API (primary, retried).
// 2) Yahoo Finance's chart API as a fallback — the same endpoint
//    scripts/backtest.js already uses successfully for intraday bars on
//    these exact tickers, so it's a proven source, not an untested new
//    dependency (unlike scraping Google Finance's HTML, which breaks
//    silently whenever Google changes a CSS class name).
// 3) If both fail, keep the previous snapshot's price for that symbol,
//    marked stale, rather than showing nothing.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const PRICES_PATH = path.join(DATA_DIR, 'prices.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function collectSymbols(report) {
  const symbols = new Set();
  const summary = report.summary || {};
  if (summary.safe_pick?.symbol) symbols.add(summary.safe_pick.symbol);
  if (summary.aggressive_pick?.symbol) symbols.add(summary.aggressive_pick.symbol);
  (report.candidates || []).forEach((c) => { if (c.symbol) symbols.add(c.symbol); });
  return [...symbols];
}

// 2026-07-16 新增：單次查價偶爾會被 TWSE API 瞬間擋下（無錯誤訊息，純粹查無資料），
// 加重試機制避免單次暫時性問題就讓這檔股票整批消失。
async function fetchTwseOnce(symbol) {
  const query = `tse_${symbol}.tw|otc_${symbol}.tw`;
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${query}&json=1&delay=0&_=${Date.now()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const q = (json.msgArray || []).find((item) => item.z && item.z !== '-' && item.y && item.y !== '-');
  if (!q) throw new Error('no matching quote in msgArray');
  const price = Number(q.z);
  const prevClose = Number(q.y);
  if (!Number.isFinite(price) || !Number.isFinite(prevClose)) throw new Error('unparseable price fields');
  return {
    price: Math.round(price * 100) / 100,
    change_pct: Math.round(((price - prevClose) / prevClose) * 10000) / 100,
    source: 'twse_mis'
  };
}

async function fetchTwse(symbol, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchTwseOnce(symbol);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(400 * attempt);
    }
  }
  console.error(`TWSE failed for ${symbol} after ${attempts} attempts: ${lastError.message}`);
  return null;
}

// 2026-07-24 新增：TWSE 查不到時的備援來源，沿用 backtest.js 已經驗證能用的
// Yahoo Finance chart API（不是重新接一個沒測過的新資料源）。
async function fetchYahoo(symbol) {
  for (const suffix of ['TW', 'TWO']) {
    const yahooSymbol = `${symbol}.${suffix}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 CHARLES-AGENT/1.0' } });
      if (!res.ok) continue;
      const payload = await res.json();
      const meta = payload?.chart?.result?.[0]?.meta;
      const price = Number(meta?.regularMarketPrice);
      const prevClose = Number(meta?.previousClose ?? meta?.chartPreviousClose);
      if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose === 0) continue;
      return {
        price: Math.round(price * 100) / 100,
        change_pct: Math.round(((price - prevClose) / prevClose) * 10000) / 100,
        source: `yahoo_finance_${suffix.toLowerCase()}`
      };
    } catch (error) {
      console.error(`Yahoo Finance failed for ${yahooSymbol}: ${error.message}`);
    }
  }
  return null;
}

async function fetchQuote(symbol) {
  return (await fetchTwse(symbol)) || (await fetchYahoo(symbol));
}

// 2026-07-16 新增：標注這批價格是「盤中即時」還是「收盤參考」，讓前端可以誠實顯示，
// 不要讓使用者誤以為看到的是即時報價（參考 CHARLES AGENT Firebase 那套系統踩過「收盤後
// 還顯示盤中舊價」的坑，這裡用時間判斷而不是留白讓人猜）。
function currentPriceType() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  const now = hour * 60 + minute;
  return now >= 540 && now <= 810 ? 'intraday' : 'close'; // 09:00–13:30
}

async function main() {
  if (!fs.existsSync(LATEST_PATH)) {
    console.log('No latest.json yet, skipping price refresh.');
    return;
  }
  const report = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
  const symbols = collectSymbols(report);
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8'));
  } catch {
    // No previous snapshot yet — fine, nothing to fall back to.
  }

  const prices = {};
  const freshSymbols = [];
  for (const symbol of symbols) {
    const quote = await fetchQuote(symbol);
    if (quote) {
      prices[symbol] = { ...quote, stale: false };
      freshSymbols.push(symbol);
    } else if (old.prices?.[symbol]) {
      // Both live sources failed for this symbol this run — better to show
      // the last known price marked stale than to show nothing.
      prices[symbol] = { ...old.prices[symbol], stale: true };
    }
  }

  const missingSymbols = symbols.filter((symbol) => !prices[symbol]);
  console.log(`Fetched ${freshSymbols.length}/${symbols.length} fresh (${symbols.length - freshSymbols.length - missingSymbols.length} from stale fallback, ${missingSymbols.length} missing entirely).`);

  // 2026-07-16 保留：如果連上一次快照都沒有可以退回，且這次全部失敗，寧可保留
  // 舊檔案不寫，也不要把畫面變成完全空白。
  if (symbols.length > 0 && freshSymbols.length === 0 && Object.keys(prices).length === 0) {
    console.error('All quote fetches failed and there is no previous snapshot to fall back to — leaving prices.json untouched.');
    process.exitCode = 1;
    return;
  }

  const out = {
    updated_at: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    // Machine-parseable companion to updated_at (which is a locale display
    // string, not reliable to parse back into a Date across browsers) — the
    // frontend uses this to compute a live "N 分鐘前" freshness display.
    updated_at_iso: new Date().toISOString(),
    price_type: currentPriceType(),
    quote_status: {
      expected: symbols.length,
      fresh: freshSymbols.length,
      is_complete: missingSymbols.length === 0,
      missing_symbols: missingSymbols
    },
    prices
  };
  fs.writeFileSync(PRICES_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote prices.json.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
