// 2026-08-06 新增：candidate-pool 的成交量/漲跌幅排行，改成從 GitHub Actions 直接抓
// TWSE 開放資料 API，取代原本完全丟給雲端 AI agent 用 6-20 組 WebSearch 硬湊的做法。
//
// 起因：daily-report-prompt.md 原本假設雲端 agent 對 TWSE/TAIFEX 全部 403，所以用
// WebSearch 降級湊候選池——但 403 只發生在雲端 agent 的沙盒 IP，refresh-prices.yml
// 這支 GitHub Actions 每 5 分鐘查 TWSE MIS 從沒被擋過，這裡沿用同樣的環境去抓
// STOCK_DAY_ALL（全市場每日 OHLCV 開放資料，不用登入、不用解析 HTML），把整個
// 「抓成交量排行」這一步從雲端 agent 身上拿掉，直接減少它單次要做的事。
//
// 這不是 TAIFEX 個股期貨的原始排行（那個仍然需要 WebSearch 確認個股是否真的有期貨
// 合約掛牌，daily-report-prompt.md 第 1 步後段的期貨合約確認邏輯保留不變），而是
// TWSE 現股的量值/漲跌幅排行，範疇更廣，可以完全取代原本的降級方案當作候選池基礎。
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'volume-ranking');
const OUT_PATH = path.join(OUT_DIR, 'latest.json');
const TOP_N = 15; // 各排行取前 N 檔，合併去重後通常落在 20-25 檔，足夠第 1 步「8-12 檔」的目標

// STOCK_DAY_ALL 的 Date 欄位是民國年（例如 "1150805" = 民國115年08月05日 = 2026-08-05）。
function rocDateToIso(rocDate) {
  const s = String(rocDate);
  const year = Number(s.slice(0, s.length - 4)) + 1911;
  const month = s.slice(-4, -2);
  const day = s.slice(-2);
  return `${year}-${month}-${day}`;
}

async function main() {
  const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`TWSE STOCK_DAY_ALL HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 500) {
    // 正常應該有 1300+ 檔上市股票，明顯偏少代表回傳資料不完整，不要當作可信結果用。
    throw new Error(`回傳筆數異常（${Array.isArray(rows) ? rows.length : 'not array'}），懷疑資料不完整`);
  }

  const parsed = rows.map((r) => {
    const close = Number(r.ClosingPrice);
    const change = Number(r.Change);
    const volume = Number(r.TradeVolume);
    const turnover = Number(r.TradeValue);
    const prevClose = close - change;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : null;
    return {
      symbol: r.Code,
      name: r.Name,
      close,
      change,
      change_pct: changePct === null ? null : Math.round(changePct * 100) / 100,
      volume,
      turnover
    };
  }).filter((r) => Number.isFinite(r.close) && r.close > 0 && Number.isFinite(r.turnover));

  const byTurnover = [...parsed].sort((a, b) => b.turnover - a.turnover).slice(0, TOP_N);
  const byMove = [...parsed]
    .filter((r) => r.change_pct !== null)
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, TOP_N);

  const merged = new Map();
  [...byTurnover, ...byMove].forEach((r) => merged.set(r.symbol, r));
  const candidates = [...merged.values()].sort((a, b) => b.turnover - a.turnover);

  const isoDate = rocDateToIso(rows[0].Date);
  const out = {
    date: isoDate,
    generated_at: new Date().toISOString(),
    source: 'twse_open_api_stock_day_all',
    note: '這是 TWSE 現股成交量/漲跌幅排行（非 TAIFEX 個股期貨原始排行），daily-report-prompt.md 第 1 步用這份當候選池基礎，仍需 WebSearch 確認每檔是否有對應期貨合約掛牌',
    total_stocks: parsed.length,
    candidates
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${candidates.length} candidates (date=${isoDate}, from ${parsed.length} total stocks) to ${OUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
