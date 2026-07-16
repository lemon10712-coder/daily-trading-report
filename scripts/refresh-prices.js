// Fetch live quotes for symbols listed in data/latest.json from TWSE's free MIS quote API
// (no API key needed) and write data/prices.json. Pure data fetch, no AI involved.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const PRICES_PATH = path.join(DATA_DIR, 'prices.json');

function collectSymbols(report) {
  const symbols = new Set();
  const summary = report.summary || {};
  if (summary.safe_pick && summary.safe_pick.symbol) symbols.add(summary.safe_pick.symbol);
  if (summary.aggressive_pick && summary.aggressive_pick.symbol) symbols.add(summary.aggressive_pick.symbol);
  (report.candidates || []).forEach(c => { if (c.symbol) symbols.add(c.symbol); });
  return [...symbols];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 2026-07-16 新增：單次查價偶爾會被 TWSE API 瞬間擋下（無錯誤訊息，純粹查無資料），
// 加重試機制避免單次暫時性問題就讓這檔股票整批消失。
async function fetchQuoteOnce(symbol) {
  const query = `tse_${symbol}.tw|otc_${symbol}.tw`;
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${query}&json=1&delay=0&_=${Date.now()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const arr = json.msgArray || [];
  const q = arr.find(entry => entry.z && entry.z !== '-' && entry.y && entry.y !== '-');
  if (!q) throw new Error('no matching quote in msgArray');
  const price = parseFloat(q.z);
  const prevClose = parseFloat(q.y);
  if (!price || !prevClose) throw new Error('unparseable price fields');
  const changePct = ((price - prevClose) / prevClose) * 100;
  return { price: Math.round(price * 100) / 100, change_pct: Math.round(changePct * 100) / 100 };
}

async function fetchQuote(symbol, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetchQuoteOnce(symbol);
    } catch (e) {
      lastError = e;
      if (i < attempts) await sleep(400 * i);
    }
  }
  console.error(`Failed to fetch ${symbol} after ${attempts} attempts:`, lastError.message);
  return null;
}

// 2026-07-16 新增：標注這批價格是「盤中即時」還是「收盤參考」，讓前端可以誠實顯示，
// 不要讓使用者誤以為看到的是即時報價（參考 CHARLES AGENT Firebase 那套系統踩過「收盤後
// 還顯示盤中舊價」的坑，這裡用時間判斷而不是留白讓人猜）。
function currentPriceType() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const minutesSinceMidnight = hour * 60 + minute;
  const marketOpen = 9 * 60; // 09:00
  const marketClose = 13 * 60 + 30; // 13:30
  return (minutesSinceMidnight >= marketOpen && minutesSinceMidnight <= marketClose) ? 'intraday' : 'close';
}

async function main() {
  if (!fs.existsSync(LATEST_PATH)) {
    console.log('No latest.json yet, skipping price refresh.');
    return;
  }
  const report = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
  const symbols = collectSymbols(report);
  const prices = {};
  for (const symbol of symbols) {
    const q = await fetchQuote(symbol);
    if (q) prices[symbol] = q;
  }

  const successCount = Object.keys(prices).length;
  console.log(`Fetched ${successCount}/${symbols.length} symbols.`);

  // 2026-07-16 新增：如果全部查價都失敗（例如 API 瞬間限流），不要把空結果寫進
  // prices.json 蓋掉上一次的正確資料——寧可讓使用者看到稍舊但正確的價格，也不要
  // 讓一次暫時性失敗把畫面變成空白。只要有查到至少 1 檔就照常寫入。
  if (symbols.length > 0 && successCount === 0) {
    console.error('All quote fetches failed this run — keeping previous prices.json untouched.');
    process.exitCode = 1;
    return;
  }

  const out = {
    updated_at: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    price_type: currentPriceType(),
    prices
  };
  fs.writeFileSync(PRICES_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote prices.json:', out);
}

main();
