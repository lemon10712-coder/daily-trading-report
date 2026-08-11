// 2026-08-06 新增，2026-08-11 升級為主力：不依賴 CCR（Claude 雲端 AI routine）、純資料+
// 公式計算的保底報告產生器。
//
// 背景：CCR 在 8/5、8/6、8/7、8/10、8/11 反覆卡死沒有產出，且看不到內部執行日誌無法對症
// 下藥根治，判斷「CCR 之後還會不會穩」沒有人能保證。2026-08-11 起使用者明確要求把這支腳本
// 從「CCR 掛掉時的陽春備案」升級成「每天都跑、不依賴 CCR 的正式主力」——GitHub Actions
// runner 連線 TWSE/TPEx/Yahoo Finance 從未被 403 過（CCR 雲端沙盒才會被擋），且這個 repo
// 的 GitHub Actions 過去幾個月完全沒斷過，是全系統最可靠的一層。CCR 如果之後真的跑出更好
// 的版本，一樣會透過現有機制（PAT push 直接觸發 publish-pdf.yml）覆蓋掉這份基礎版，兩者不
// 衝突、疊加運作。
//
// 2026-08-11 這次升級新增兩項風險查核（原本只有陽春版才會缺的部分），縮小跟 AI 版本的品質
// 差距：處置股排除（官方 API，非 AI 判斷但同樣可信；注意股目前未查核，見下方函式註解）、SOX 費半指數連動（半導體供應鏈
// 候選股在 SOX 大跌時調降信心分數）。代價仍然誠實寫在 data_quality.warnings：沒有法人動向/
// 個股新聞/法說會這類需要真人或 AI 閱讀理解的敘事內容。
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
  return new Promise((resolve) => {
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

// ROC (民國) 日期字串轉西元 yyyy-mm-dd，接受 "115/08/07" 或 "1150807" 兩種格式
function rocToIso(raw) {
  const s = String(raw).replace(/\//g, '');
  if (s.length !== 7) return null;
  const year = Number(s.slice(0, 3)) + 1911;
  const month = s.slice(3, 5);
  const day = s.slice(5, 7);
  return `${year}-${month}-${day}`;
}

function isTodayWithinPeriod(periodRaw, todayIso) {
  if (!periodRaw) return true; // 查不到期間就保守當作仍在處置中，寧可誤刪不要誤放
  const parts = String(periodRaw).split(/[～~]/).map((p) => p.trim());
  if (parts.length !== 2) return true;
  const start = rocToIso(parts[0]);
  const end = rocToIso(parts[1]);
  if (!start || !end) return true;
  return todayIso >= start && todayIso <= end;
}

// 處置股體檢：TWSE + TPEx 官方公告 API，純資料查詢不需要 AI 判斷，
// 可信度跟 daily-report-prompt.md 那條 AI 路線的「WebSearch 查處置股」是同一件事、
// 只是查證方式從搜尋引擎換成官方開放資料，結果更精確（不會漏、不會抓到舊聞）。
// 2026-08-11 round 3 自我審視發現：這裡只查了「處置」（announcement/punish、
// tpex_disposal_information），沒有查「注意股」（處置的前一階段，daily-report-prompt.md
// 定義風險偏高但還能交易）。TWSE 有 announcement/notice 這支 API 疑似對應注意股，
// 但今天測試回傳的是一筆 Code 為空的預留格式列，無法判斷是「今天真的沒有注意股」還是
// 「這支 API 本身沒查對」，沒有把握的資料來源不能拿來當「已排除」的依據去騙自己/騙
// 使用者，所以刻意不接——寧可誠實承認「注意股本版本未查核」，也不要接一個沒驗證過在
// 真正有資料的日子會不會正常運作的來源。之後如果要補這塊，要先在真的有注意股的交易日
// 驗證這支 API（或找到 TPEx 對應端點）會不會正確回傳，再接進來。
async function fetchDispositionSymbols(todayIso) {
  const disposed = new Set();
  const sources = [];

  const twse = await httpGetJson('https://openapi.twse.com.tw/v1/announcement/punish');
  if (Array.isArray(twse)) {
    sources.push('twse');
    twse.forEach((row) => {
      const code = String(row.Code || '').trim();
      // 只保留 4 碼股票代號（權證/受益證券代號較長，不是我們候選池會出現的標的）
      if (!/^\d{4}$/.test(code)) return;
      if (isTodayWithinPeriod(row.DispositionPeriod, todayIso)) disposed.add(code);
    });
  }

  const tpex = await httpGetJson('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information');
  if (Array.isArray(tpex)) {
    sources.push('tpex');
    tpex.forEach((row) => {
      const code = String(row.SecuritiesCompanyCode || '').trim();
      if (!/^\d{4}$/.test(code)) return;
      if (isTodayWithinPeriod(row.DispositionPeriod, todayIso)) disposed.add(code);
    });
  }

  return { disposed, sources, ok: sources.length > 0 };
}

// 半導體/AI供應鏈概念股靜態名單：SOX 連動風險調整只套用在這份名單內的候選股，避免對
// 完全不相關的產業（食品、營建等）誤套用半導體系統性風險。名單來源：daily-report-prompt.md
// 第 6b 步「候選股屬半導體/AI供應鏈類股一律查 SOX」規則點名過的族群（晶圓代工/封測/記憶體/
// IC設計/矽晶圓），加上台股成交量/新聞版面最常出現的相關個股。這是保底版的已知簡化——
// 不是動態產業分類，之後如果發現漏掉常見標的要回來補這份清單。
const SEMI_SUPPLY_CHAIN_SYMBOLS = new Set([
  '2330', '2303', '3711', '2454', '2408', '2344', '6488', '3037', '3189', '8046',
  '2379', '2449', '3034', '2451', '5347', '6182', '3532', '2337', '6669', '3324',
  '2401', '2481', '3661', '4966', '2314', '8299', '3443', '3105', '6510'
]);

async function fetchSoxChangePct() {
  const json = await httpGetJson('https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX?interval=1d&range=5d');
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) return null;
  const closes = (result.indicators.quote[0] || {}).close || [];
  const valid = closes.map((c, i) => ({ c, t: result.timestamp[i] })).filter((x) => Number.isFinite(x.c));
  if (valid.length < 2) return null;
  const last = valid[valid.length - 1].c;
  const prev = valid[valid.length - 2].c;
  if (!prev) return null;
  return Math.round(((last - prev) / prev) * 10000) / 100;
}

// 交易日曆檢查（2026-08-11 新增）：2026-07-10 曾發生颱風全日休市當天，AI 那條路線
// 因為沒查交易日曆，照樣生出一份給不存在交易日用的進場建議。這支保底層原本完全沒有
// 這層防呆——CCR 掛掉時剛好又遇到國定假日，一樣會重演同一種錯誤，而且保底層現在是
// 每天 08:20 就跑的主力，暴露機會比以前更高。用 TWSE 官方年度休市日曆 API 查核。
// 已知限制：這份年度日曆只涵蓋「事先排定的國定假日」（春節/國慶等），不包含颱風假這種
// 臨時性、氣象決定的當日休市——TWSE 沒有提供「今天是否颱風假」的公開即時 API，這個
// 保底層目前無法自動偵測颱風假，仍然是已知殘留風險（跟 CCR 那條路線一樣，颱風假要
// 靠其他管道才查得到）。
async function isKnownHoliday(todayIso) {
  const json = await httpGetJson('https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule');
  if (!Array.isArray(json)) return { isHoliday: null, name: null }; // 查詢失敗，無法判斷
  const hit = json.find((row) => rocToIso(row.Date) === todayIso);
  if (!hit) return { isHoliday: false, name: null };
  // 日曆裡也包含「開始交易日」這類描述當天正常交易的條目（不是休市），只有名稱/說明
  // 明確講「放假」「休市」「無交易」才算真的休市，避免把「春節後開始交易日」誤判成休市。
  const text = `${hit.Name}${hit.Description}`;
  const isTrading = /開始交易|恢復交易/.test(hit.Name);
  const isClosed = !isTrading && /放假|休市|無交易/.test(text);
  return { isHoliday: isClosed, name: hit.Name };
}

function priceTier(entry) {
  if (entry < 100) return 'under100';
  if (entry < 250) return '100to250';
  if (entry < 500) return '250to500';
  return '500plus';
}

const round = (n) => Math.round(n * 100) / 100;

// 台股法定升降單位（tick size）：交易所只接受下面級距的倍數，掛不合法級距的價格
// 會直接被券商系統拒單。2026-08-11 修正：先前只用 round() 四捨五入到小數點後兩位，
// 完全沒有校正成合法跳動單位，算出來的 entry/stop/target 常常是掛不了單的價格
// （例如 100-500 元區間出現 121.8 這種非 0.5 倍數的數字）。
function tickSize(price) {
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

// 依價格自己所在的級距（不是依 prevClose 的級距）捨入到最近的合法跳動單位——
// 進場價可能因為 ×1.01 剛好跨過級距邊界（例如前收99.5算出entryHigh=100.5，
// 這已經是100-500元級距，要用0.5而不是99元那邊的0.1）。
function roundToTick(price) {
  const tick = tickSize(price);
  return Math.round(Math.round(price / tick) * tick * 100) / 100;
}

// 固定公式：進場價=前收1.005-1.01倍（小幅拉回買點）、停損=前收0.985倍(-1.5%，風險窄)、
// 停利=前收1.03倍(+3%)、目標=前收1.09倍或漲停價97%取較小值（不超過真實漲停）。
// 數學上保證：risk(進場上緣-停損)=2.5%，reward(目標-進場上緣)最差情況(被漲停頂住時)
// 仍有約5.7%，風險報酬比穩定在2以上；停利跟目標之間留足3.5%以上級距，避免被
// validate-report.js判定「抄前一天高點」。這是通用公式，不是針對個股特性判斷過的
// 結果，這點會誠實寫進 risk_tag／data_quality.warnings。所有會被使用者拿去實際
// 下單的價位（entry/stop/target/take_profit）一律用 roundToTick，不是純統計用途
// 的數字（例如風報比）才維持一般 round()。
function computeLevels(prevClose, upper) {
  const entryLow = roundToTick(prevClose * 1.005);
  const entryHigh = roundToTick(prevClose * 1.01);
  const stopLoss = roundToTick(prevClose * 0.985);
  const takeProfit = roundToTick(prevClose * 1.03);
  const target = roundToTick(Math.min(prevClose * 1.09, upper * 0.97));
  return { entryLow, entryHigh, stopLoss, takeProfit, target };
}

// early_stop 是 entry 與 stop_loss 中點，一樣是實際下單價位要合法跳動單位；
// 校正後理論上仍嚴格落在 (stopLoss, entryLow) 之間（區間寬度通常遠大於一個tick），
// 但邊界情況（低價股/tick剛好卡在區間邊緣）用一次性微調保底，不讓 validate-report.js
// 判定 early_stop 越界。
function computeEarlyStop(entryLow, stopLoss) {
  let mid = roundToTick((entryLow + stopLoss) / 2);
  const tick = tickSize(mid);
  if (mid <= stopLoss) mid = roundToTick(stopLoss + tick);
  if (mid >= entryLow) mid = roundToTick(entryLow - tick);
  return mid;
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

  const holidayCheck = await isKnownHoliday(today);
  if (holidayCheck.isHoliday) {
    console.log(`今天（${today}）是台股休市日「${holidayCheck.name}」（TWSE官方年度日曆），寫入休市版報告，不產生進場建議。`);
    const report = {
      schema_version: 3,
      date: today,
      generated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16),
      provisional: false,
      market_open: false,
      market_closed_reason: holidayCheck.name,
      source_layer: 'base_formulaic',
      data_quality: { warnings: [`今天是台股休市日（${holidayCheck.name}，TWSE官方年度日曆查得），不產生進場建議。`] },
      sentiment: { score: 50, label: '休市', factors: [] },
      narrative_timeline: [],
      summary: { recommendations: [] },
      candidates: [],
      news: []
    };
    fs.writeFileSync(LATEST_PATH, JSON.stringify(report, null, 2) + '\n');
    return;
  }
  if (holidayCheck.isHoliday === null) {
    console.log('警告：TWSE官方休市日曆查詢失敗，無法確認今天是否為交易日，繼續照一般交易日流程產生報告（可能有誤判風險，人工複核時留意）。');
  }

  if (!fs.existsSync(RANKING_PATH)) {
    console.error('data/volume-ranking/latest.json not found — cannot generate base report without it.');
    process.exitCode = 1;
    return;
  }
  const ranking = JSON.parse(fs.readFileSync(RANKING_PATH, 'utf8'));
  const pool = (ranking.candidates || []).slice(0, 20);

  const [dispositionResult, soxChangePct] = await Promise.all([
    fetchDispositionSymbols(today),
    fetchSoxChangePct(),
  ]);
  const { disposed, ok: dispositionOk } = dispositionResult;
  const excludedForDisposition = pool.filter((c) => disposed.has(c.symbol));
  const poolClean = pool.filter((c) => !disposed.has(c.symbol)).slice(0, 15);

  const soxSevere = Number.isFinite(soxChangePct) && Math.abs(soxChangePct) >= 2;
  const soxDirection = Number.isFinite(soxChangePct) ? (soxChangePct < 0 ? 'bear' : 'bull') : null;

  const enriched = [];
  for (const c of poolClean) {
    const limits = await fetchLimits(c.symbol);
    if (!limits) continue;
    const levels = computeLevels(limits.prevClose, limits.upper);
    const isSemi = SEMI_SUPPLY_CHAIN_SYMBOLS.has(c.symbol);
    let confidence = 45;
    let soxNote = null;
    if (isSemi && soxSevere) {
      confidence = soxDirection === 'bear' ? 35 : 50;
      soxNote = soxDirection === 'bear'
        ? `美股費半指數(SOX)前一交易日重挫${Math.abs(soxChangePct)}%，本檔屬半導體/AI供應鏈概念股，情緒外溢風險偏高，信心分數已調降`
        : `美股費半指數(SOX)前一交易日大漲${soxChangePct}%，本檔屬半導體/AI供應鏈概念股，可能有正向外溢`;
    }
    enriched.push({ ...c, ...limits, ...levels, tier: priceTier(levels.entryLow), isSemi, soxNote, confidence });
  }

  if (enriched.length === 0) {
    console.error('Could not fetch live limits for any candidate — aborting rather than publishing empty data.');
    process.exitCode = 1;
    return;
  }

  const actionable = enriched.filter((c) => c.tier === '100to250' || c.tier === '250to500');
  const observation = enriched.filter((c) => c.tier === '500plus' || c.tier === 'under100');

  const baseRiskTag = (c) => {
    const parts = ['本檔為保底基礎版公式計算結果，已排除官方公告的處置股（注意股本版本未查核），未經法說會與個股新聞查證，僅供參考，正式版待CCR恢復後補上'];
    if (c.soxNote) parts.push(c.soxNote);
    return parts.join('；');
  };

  const toRecommendation = (c) => ({
    symbol: c.symbol,
    name: c.name,
    type: 'safe',
    reason: `成交值/漲跌幅排行前段（前一交易日成交值約 ${(c.turnover / 1e8).toFixed(1)} 億元），依固定公式（前收1.005-1.01倍拉回進場、停損-1.5%、目標視今日真實漲跌停區間）計算，非個股層級 AI 判斷結果`,
    entry: `${c.entryLow}-${c.entryHigh}`,
    take_profit: String(c.takeProfit),
    target: String(c.target),
    stop_loss: String(c.stopLoss),
    early_stop: String(computeEarlyStop(c.entryLow, c.stopLoss)),
    risk_reward_ratio: String(round((c.target - c.entryHigh) / (c.entryHigh - c.stopLoss))),
    invalidation_reason: '跌破停損價，或開盤即跳空超出進場區間，策略失效',
    prior_day_change_pct: c.change_pct,
    risk_tag: baseRiskTag(c),
    confidence_score: c.confidence,
    confidence_factors: c.soxNote ? ['公式化保底版本，固定45分', c.soxNote] : ['公式化保底版本，未經個股層級風險體檢，固定給45分']
  });

  const toCandidate = (c, rank) => ({
    rank,
    symbol: c.symbol,
    name: c.name,
    category: c.isSemi ? '半導體/AI供應鏈（保底版靜態分類）' : '未分類（保底版本未做族群查證）',
    summary: `前一交易日成交值約 ${(c.turnover / 1e8).toFixed(1)} 億元，漲跌幅 ${c.change_pct}%`,
    entry: `${c.entryLow}-${c.entryHigh}`,
    take_profit: String(c.takeProfit),
    target: String(c.target),
    stop_loss: String(c.stopLoss),
    early_stop: String(computeEarlyStop(c.entryLow, c.stopLoss)),
    risk_reward_ratio: String(round((c.target - c.entryHigh) / (c.entryHigh - c.stopLoss))),
    invalidation_reason: '跌破停損價，或開盤即跳空超出進場區間，策略失效',
    prior_day_change_pct: c.change_pct,
    plan_a: `拉回 ${c.entryLow}-${c.entryHigh} 進場，跌破停損 ${c.stopLoss} 出場`,
    plan_b: '本版本未提供突破追價備案，建議僅採A計畫或觀望',
    risk_tag: baseRiskTag(c)
  });

  const warnings = [
    '【保底基礎版】這份報告由 GitHub Actions 純程式化產生，作為每個交易日的正式主力（2026-08-11起），不依賴 Claude 雲端 AI（CCR）、也不依賴任何對話 session 存活，觸發於每個交易日 08:20（不再等待 CCR，CCR 如果之後成功產出更完整的版本會自動覆蓋這份基礎版）。',
    '進場/停利/目標/停損價位是用固定公式（前收1.005-1.01倍進場、停損-1.5%、目標取前收+9%與今日真實漲停價97%兩者較小值）計算，搭配 TWSE 官方即時 API 查到的真實漲跌停區間，數字本身正確可信。',
    dispositionOk
      ? `已用 TWSE／TPEx 官方公告 API 查核處置股（不含注意股，這個保底版本目前未查核注意股，見程式碼註解），${excludedForDisposition.length > 0 ? `排除了 ${excludedForDisposition.map((c) => `${c.symbol} ${c.name}`).join('、')} 這 ${excludedForDisposition.length} 檔` : '今天候選池內沒有命中的標的'}。`
      : '處置股官方 API 查詢失敗（TWSE 或 TPEx 端點無回應），本次無法保證候選池已排除處置股，人工複核時要特別留意。',
    Number.isFinite(soxChangePct)
      ? `美股費半指數(SOX)前一交易日收盤變動 ${soxChangePct}%${soxSevere ? '（判定為顯著變動，已對半導體/AI供應鏈概念股候選調整信心分數）' : '（變動幅度不大，未觸發風險調整）'}。`
      : '查不到美股費半指數(SOX)資料，本次無法納入國際盤勢連動判斷。',
    '候選池來自前一交易日 TWSE 成交量/漲跌幅排行（GitHub Actions 抓取，真實資料），未經「是否有掛牌個股期貨」的資格確認，也沒有法人動向、個股新聞、法說會這類需要人工或 AI 閱讀理解的敘事內容——這些等 CCR 恢復正常後由完整版覆蓋補上。'
  ];

  const report = {
    schema_version: 3,
    date: today,
    generated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16),
    provisional: true,
    market_open: true,
    source_layer: 'base_formulaic',
    data_quality: { warnings },
    sentiment: { score: 50, label: '中性（保底版本未做情緒分析）', factors: [] },
    narrative_timeline: [],
    summary: { recommendations: actionable.slice(0, 6).map(toRecommendation) },
    candidates: enriched.map((c, i) => toCandidate(c, i + 1)),
    news: []
  };

  fs.writeFileSync(LATEST_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote base report: ${actionable.length} actionable / ${observation.length} observation-only candidates. Disposition-excluded: ${excludedForDisposition.length}. SOX: ${soxChangePct}%.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
