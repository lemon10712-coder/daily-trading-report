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

async function fetchQuote(symbol) {
  const query = `tse_${symbol}.tw|otc_${symbol}.tw`;
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${query}&json=1&delay=0&_=${Date.now()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const json = await res.json();
  const arr = json.msgArray || [];
  const q = arr.find(entry => entry.z && entry.z !== '-' && entry.y && entry.y !== '-');
  if (!q) return null;
  const price = parseFloat(q.z);
  const prevClose = parseFloat(q.y);
  if (!price || !prevClose) return null;
  const changePct = ((price - prevClose) / prevClose) * 100;
  return { price: Math.round(price * 100) / 100, change_pct: Math.round(changePct * 100) / 100 };
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
    try {
      const q = await fetchQuote(symbol);
      if (q) prices[symbol] = q;
    } catch (e) {
      console.error(`Failed to fetch ${symbol}:`, e.message);
    }
  }
  const out = {
    updated_at: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    prices
  };
  fs.writeFileSync(PRICES_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote prices.json:', out);
}

main();
