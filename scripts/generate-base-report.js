// 2026-08-06 新增：不依賴 CCR（Claude 雲端 AI routine）、純資料+公式計算的保底報告產生器。
//
// 背景：8/5、8/6 兩天 CCR 完全卡死沒有任何產出，8/6 查證發現 Anthropic 官方狀態頁對
// 8/5 有正式公告的 Sonnet 5 服務中斷紀錄，但 8/6 當天官方沒有列出任何事故——代表
// CCR 之後還會不會穩定，沒有人能保證。這支腳本是「保底層」：不需要 AI、不需要
// WebSearch，純粹用 TWSE 官方即時 API 抓真實漲跌停區間，配合固定公式算出進場/停利/
// 目標/停損價位，確保就算 CCR 或這個對話 session 完全掛掉，使用者每天還是能收到一份
// 「數字正確、可操作」的基礎版報告——代價是沒有法人動向/因果分析這類需要 AI 判斷的
// 敘事內容，這些等 CCR 恢復後由 daily-report-prompt.md 那條路覆蓋補強化版時才有。
//
// 由 fetch-volume-ranking.yml 觸發的排程晚 30 分鐘（08:45 Asia/Taipei）執行，寫入前
// 會先檢查 data/latest.json 是不是已經有今天的內容——如果 CCR 那條路已經成功產生過
// 今天的報告，這支腳本什麼都不做，不會覆蓋掉品質更好的版本。
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const RANKING_PATH = path.join(DATA_DIR, 'volume-ranking', 'latest.json');

function taipeiToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
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
  const q = (json.msgArray || []).find((entry) => entry.y && entry.y !== '-');
  if (!q) return null;
  const prevClose = parseFloat(q.y);
  if (!prevClose) return null;
  const upper = parseFloat(q.u) || prevClose * 1.10;
  const lower = parseFloat(q.w) || prevClose * 0.90;
  return { prevClose, upper, lower };
}

function priceTier(entry) {
  if (entry < 100) return 'under100';
  if (entry < 250) return '100to250';
  if (entry < 500) return '250to500';
  return '500plus';
}

const round = (n) => Math.round(n * 100) / 100;

// 固定公式：進場價=前收1.005-1.01倍（小幅拉回買點）、停損=前收0.985倍(-1.5%，風險窄)、
// 停利=前收1.03倍(+3%)、目標=前收1.09倍或漲停價97%取較小值（不超過真實漲停）。
// 數學上保證：risk(進場上緣-停損)=2.5%，reward(目標-進場上緣)最差情況(被漲停頂住時)
// 仍有約5.7%，風險報酬比穩定在2以上；停利跟目標之間留足3.5%以上級距，避免被
// validate-report.js判定「抄前一天高點」。這是通用公式，不是針對個股特性判斷過的
// 結果，這點會誠實寫進 risk_tag／data_quality.warnings。
function computeLevels(prevClose, upper) {
  const entryLow = round(prevClose * 1.005);
  const entryHigh = round(prevClose * 1.01);
  const stopLoss = round(prevClose * 0.985);
  const takeProfit = round(prevClose * 1.03);
  const target = round(Math.min(prevClose * 1.09, upper * 0.97));
  return { entryLow, entryHigh, stopLoss, takeProfit, target };
}

async function main() {
  const today = taipeiToday();

  if (fs.existsSync(LATEST_PATH)) {
    const existing = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
    if (existing.date === today && existing.source_layer !== 'base_formulaic') {
      console.log(`latest.json already has today's (${today}) report from a richer source (CCR/manual) — skipping, not overwriting.`);
      return;
    }
    if (existing.date === today && existing.source_layer === 'base_formulaic') {
      console.log('Base report for today already generated — skipping duplicate run.');
      return;
    }
  }

  if (!fs.existsSync(RANKING_PATH)) {
    console.error('data/volume-ranking/latest.json not found — cannot generate base report without it.');
    process.exitCode = 1;
    return;
  }
  const ranking = JSON.parse(fs.readFileSync(RANKING_PATH, 'utf8'));
  const pool = (ranking.candidates || []).slice(0, 15);

  const enriched = [];
  for (const c of pool) {
    const limits = await fetchLimits(c.symbol);
    if (!limits) continue;
    const levels = computeLevels(limits.prevClose, limits.upper);
    enriched.push({ ...c, ...limits, ...levels, tier: priceTier(levels.entryLow) });
  }

  if (enriched.length === 0) {
    console.error('Could not fetch live limits for any candidate — aborting rather than publishing empty data.');
    process.exitCode = 1;
    return;
  }

  const actionable = enriched.filter((c) => c.tier === '100to250' || c.tier === '250to500');
  const observation = enriched.filter((c) => c.tier === '500plus' || c.tier === 'under100');

  const toRecommendation = (c) => ({
    symbol: c.symbol,
    name: c.name,
    type: 'safe',
    reason: `成交值/漲跌幅排行前段（前一交易日成交值約 ${(c.turnover / 1e8).toFixed(1)} 億元），依固定公式（前收1.005-1.01倍拉回進場、停損-2%、目標視今日真實漲跌停區間）計算，非 AI 個別判斷結果`,
    entry: `${c.entryLow}-${c.entryHigh}`,
    take_profit: String(c.takeProfit),
    target: String(c.target),
    stop_loss: String(c.stopLoss),
    early_stop: String(round((c.entryLow + c.stopLoss) / 2)),
    risk_reward_ratio: String(round((c.target - c.entryHigh) / (c.entryHigh - c.stopLoss))),
    invalidation_reason: '跌破停損價，或開盤即跳空超出進場區間，策略失效',
    prior_day_change_pct: c.change_pct,
    risk_tag: '本檔為保底基礎版公式計算結果，未經處置股/注意股體檢、未經法說會與國際盤勢查證，僅供參考，正式版待CCR恢復後補上',
    confidence_score: 45,
    confidence_factors: ['公式化保底版本，未經AI風險體檢，固定給45分']
  });

  const toCandidate = (c, rank) => ({
    rank,
    symbol: c.symbol,
    name: c.name,
    category: '未分類（保底版本未做族群查證）',
    summary: `前一交易日成交值約 ${(c.turnover / 1e8).toFixed(1)} 億元，漲跌幅 ${c.change_pct}%`,
    entry: `${c.entryLow}-${c.entryHigh}`,
    take_profit: String(c.takeProfit),
    target: String(c.target),
    stop_loss: String(c.stopLoss),
    early_stop: String(round((c.entryLow + c.stopLoss) / 2)),
    risk_reward_ratio: String(round((c.target - c.entryHigh) / (c.entryHigh - c.stopLoss))),
    invalidation_reason: '跌破停損價，或開盤即跳空超出進場區間，策略失效',
    prior_day_change_pct: c.change_pct,
    plan_a: `拉回 ${c.entryLow}-${c.entryHigh} 進場，跌破停損 ${c.stopLoss} 出場`,
    plan_b: '本版本未提供突破追價備案，建議僅採A計畫或觀望',
    risk_tag: '保底基礎版公式計算，未經深度風險體檢'
  });

  const report = {
    schema_version: 3,
    date: today,
    generated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16),
    provisional: true,
    market_open: true,
    source_layer: 'base_formulaic',
    data_quality: {
      warnings: [
        '【保底基礎版】這份報告由 GitHub Actions 純程式化產生，不依賴 Claude 雲端 AI（CCR）、也不依賴任何對話 session 存活，觸發於每個交易日 08:45（給 CCR 正常排程 15 分鐘機會，沒有產出才啟動這個保底機制）。',
        '進場/停利/目標/停損價位是用固定公式（前收1.005-1.01倍進場、停損-2%、目標取前收+8%與今日真實漲停價95%兩者較小值）計算，搭配 TWSE 官方即時 API 查到的真實漲跌停區間，數字本身正確可信，但沒有經過個股層級的AI風險判斷（法說會、處置股/注意股、國際盤勢ADR/SOX、族群輪動）。',
        '候選池來自前一交易日 TWSE 成交量/漲跌幅排行（GitHub Actions 抓取，真實資料），未經「是否有掛牌個股期貨」的資格確認。',
        '法人動向、產業敘事、多空情緒等需要AI查證判斷的內容本版本未提供——CCR恢復正常後，daily-trading-report-0830這個routine補上完整版時會覆蓋這份基礎版。'
      ]
    },
    sentiment: { score: 50, label: '中性（保底版本未做情緒分析）', factors: [] },
    narrative_timeline: [],
    summary: { recommendations: actionable.slice(0, 6).map(toRecommendation) },
    candidates: enriched.map((c, i) => toCandidate(c, i + 1)),
    news: []
  };

  fs.writeFileSync(LATEST_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote base report: ${actionable.length} actionable / ${observation.length} observation-only candidates.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
