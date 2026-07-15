// 發布前健檢：檢查 data/latest.json 裡每一檔的進場/停利/目標/停損價
// 有沒有落在合理的漲跌停區間內，抓「漲停算錯」「價格區間塞錯」這類會直接誤導交易決策的錯誤。
// 純資料檢查，不用 AI，抓到問題就印出來並以非零狀態碼結束（給人或給 agent 判斷要不要擋下發布）。
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');

// 台股一般股票漲跌幅上限 ±10%，當作查不到 TWSE 官方 u/w 欄位時的備用估算
const LIMIT_PCT = 0.10;
const TOLERANCE_PCT = 0.01; // 抓到剛好卡在邊界、四捨五入造成的誤差，多留 1% 緩衝

function httpGetJson(url) {
  // 用內建 https 模組而不是 fetch()：在部分 Node/Windows 組合下，fetch() 底層的 undici
  // 連線池會讓 process.exit() 在收尾時觸發 libuv assertion crash（跟這支腳本的邏輯無關，
  // 是環境層級的已知問題），改用 https.get 完全避開，行為更可預期。
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchLimits(symbol) {
  const query = `tse_${symbol}.tw|otc_${symbol}.tw`;
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${query}&json=1&delay=0&_=${Date.now()}`;
  const json = await httpGetJson(url);
  if (!json) return null;
  const arr = json.msgArray || [];
  const q = arr.find(entry => entry.y && entry.y !== '-');
  if (!q) return null;
  const prevClose = parseFloat(q.y);
  if (!prevClose) return null;
  // u/w 是 TWSE 當天官方計算好、tick size 精算過的漲停/跌停價，比自己用 ±10% 概算更準；查不到才退回估算
  const officialUpper = parseFloat(q.u);
  const officialLower = parseFloat(q.w);
  return {
    prevClose,
    upper: officialUpper || prevClose * (1 + LIMIT_PCT),
    lower: officialLower || prevClose * (1 - LIMIT_PCT),
  };
}

function parsePrice(str) {
  if (str === null || str === undefined) return null;
  const match = String(str).match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function checkPick(label, pick, limits, errors, warnings, requireFields) {
  if (!pick || !pick.symbol) return;
  const fieldNames = ['entry', 'take_profit', 'target', 'stop_loss'];
  const parsed = {};
  for (const key of fieldNames) {
    const raw = pick[key];
    if (raw === undefined) {
      // candidates 排行榜的欄位是自由文字的 plan_a/plan_b，schema 沒規定要有這四個數字欄位，
      // 完全沒有就不用當問題；只有「summary 的兩個主推薦」才要求一定要有
      if (requireFields) warnings.push(`${label}（${pick.symbol} ${pick.name || ''}）缺少 ${key} 欄位`);
      continue;
    }
    const val = parsePrice(raw);
    if (val === null) {
      warnings.push(`${label}（${pick.symbol} ${pick.name || ''}）${key} 欄位 "${raw}" 無法解析出數字，人工複核一下`);
      continue;
    }
    parsed[key] = val;
  }

  if (Object.keys(parsed).length > 0) {
    if (limits) {
      const upperBound = limits.upper * (1 + TOLERANCE_PCT);
      const lowerBound = limits.lower * (1 - TOLERANCE_PCT);
      for (const [key, val] of Object.entries(parsed)) {
        if (val > upperBound) {
          errors.push(`${label}（${pick.symbol} ${pick.name || ''}）${key}=${val} 超過漲停價（前收 ${limits.prevClose}，漲停約 ${limits.upper.toFixed(2)}）——可能算錯漲停`);
        }
        if (val < lowerBound) {
          errors.push(`${label}（${pick.symbol} ${pick.name || ''}）${key}=${val} 低於跌停價（前收 ${limits.prevClose}，跌停約 ${limits.lower.toFixed(2)}）——可能算錯跌停`);
        }
      }
    } else {
      warnings.push(`${label}（${pick.symbol} ${pick.name || ''}）查不到前收盤價，無法驗證漲跌停區間，人工複核一下`);
    }
  }

  // 邏輯順序檢查：停損 < 進場 < 目標（不管前收盤價查不查得到都能做）
  if (parsed.entry !== undefined && parsed.stop_loss !== undefined && parsed.stop_loss >= parsed.entry) {
    errors.push(`${label}（${pick.symbol} ${pick.name || ''}）停損價 ${parsed.stop_loss} 沒有低於進場價 ${parsed.entry}，邏輯不合理`);
  }
  if (parsed.entry !== undefined && parsed.target !== undefined && parsed.target <= parsed.entry) {
    errors.push(`${label}（${pick.symbol} ${pick.name || ''}）目標價 ${parsed.target} 沒有高於進場價 ${parsed.entry}，邏輯不合理`);
  }
}

async function main() {
  if (!fs.existsSync(LATEST_PATH)) {
    console.log('沒有 latest.json，略過健檢。');
    process.exit(0);
  }
  const report = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
  const errors = [];
  const warnings = [];

  // 結構檢查
  if (!report.date || report.date === '尚未產生') errors.push('date 欄位是預設值，報告還沒真的產生過');
  if (!report.generated_at) warnings.push('generated_at 是空的');
  if (!report.summary || !report.summary.safe_pick) errors.push('summary.safe_pick 是空的');
  if (!report.summary || !report.summary.aggressive_pick) errors.push('summary.aggressive_pick 是空的');
  if (!Array.isArray(report.candidates) || report.candidates.length === 0) errors.push('candidates 是空陣列');

  // 日期新鮮度檢查（用台北時區判斷是不是今天，只警告不擋，因為可能是收假日補發的舊報告）
  if (report.date && report.date !== '尚未產生') {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // yyyy-mm-dd
    if (report.date !== today) {
      warnings.push(`report.date=${report.date} 跟今天（台北時間 ${today}）不一致，確認是不是忘記更新`);
    }
  }

  const picks = [];
  if (report.summary) {
    if (report.summary.safe_pick) picks.push(['安全牌', report.summary.safe_pick, true]);
    if (report.summary.aggressive_pick) picks.push(['衝最快', report.summary.aggressive_pick, true]);
  }
  (report.candidates || []).forEach((c, i) => picks.push([`候選#${c.rank || i + 1}`, c, false]));

  const limitsCache = {};
  for (const [label, pick, requireFields] of picks) {
    if (!pick.symbol) continue;
    if (!(pick.symbol in limitsCache)) {
      try {
        limitsCache[pick.symbol] = await fetchLimits(pick.symbol);
      } catch (e) {
        limitsCache[pick.symbol] = null;
      }
    }
    checkPick(label, pick, limitsCache[pick.symbol], errors, warnings, requireFields);
  }

  console.log(`健檢完成：${picks.length} 檔，${errors.length} 個錯誤，${warnings.length} 個警告`);
  if (warnings.length) {
    console.log('\n--- 警告（不擋發布，但建議看一下）---');
    warnings.forEach(w => console.log('⚠ ' + w));
  }
  if (errors.length) {
    console.log('\n--- 錯誤（會擋發布，必須修正）---');
    errors.forEach(e => console.log('✗ ' + e));
    process.exit(1);
  }
  console.log('\n沒有發現漲跌停或邏輯錯誤，可以發布。');
}

main().catch(e => {
  console.error('健檢腳本本身出錯：', e.message);
  process.exit(1);
});
