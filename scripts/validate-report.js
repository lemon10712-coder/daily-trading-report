// 發布前健檢：檢查 data/latest.json 裡每一檔的進場/停利/目標/停損價
// 有沒有落在合理的漲跌停區間內，抓「漲停算錯」「價格區間塞錯」這類會直接誤導交易決策的錯誤。
// 純資料檢查，不用 AI，抓到問題就印出來並以非零狀態碼結束（給人或給 agent 判斷要不要擋下發布）。
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const RESULT_PATH = path.join(__dirname, '..', '.validate-result.json');

// 台股一般股票漲跌幅上限 ±10%，當作查不到 TWSE 官方 u/w 欄位時的備用估算
const LIMIT_PCT = 0.10;
const TOLERANCE_PCT = 0.01; // 抓到剛好卡在邊界、四捨五入造成的誤差，多留 1% 緩衝

// 2026-07-16 新增：參考 CHARLES AGENT Firebase 那套系統踩過的坑補上的兩條防呆規則
// 2026-08-03 改：門檻從通用估計值改成使用者真實本金（50萬），且從「軟性警告文字」
// 改成機器算好、寫回 latest.json 的結構化欄位（affordable/lot_cost_ntd/capital_note），
// 套用到全部條目（含 candidates），不再只管 safe_pick/aggressive_pick 兩檔主推薦。
const CAPITAL_CAP = 500000; // 單張成本上限（進場價 × 1000），超過就標記 affordable:false
const NEAR_LIMIT_PCT = 0.97; // 進場/停利/目標價落在漲停價 97% 以上，視為「貼近漲停」

// 2026-08-04 新增：股價區間分類，取代原本「安全牌+衝最快固定2檔」的結構。這是機器算的
// （純看entry價），不依賴LLM生成時有沒有正確分類，確保就算生成端分類錯誤，post-process
// 也能校正到一致的結果。500元以上這一區跟CAPITAL_CAP=500000是同一件事的兩種講法
// （500元 × 1000股 = 50萬，剛好是本金上限），market_observation_only因此直接掛在這一區。
function computePriceTier(entry) {
  if (!Number.isFinite(entry)) return null;
  if (entry < 100) return 'under100';
  if (entry < 250) return '100to250';
  if (entry < 500) return '250to500';
  return '500plus';
}
const MIN_NEWS_COUNT = 8;
const MIN_NEWS_CATEGORIES = 5;

// 2026-07-16 新增（真實事故）：目標價曾經被抄成前一天的最高價，導致遠低於今天真正的
// 漲停、且跟停利點擠在一起。這條數字上不算違法（沒超過漲停），過去的檢查完全抓不到，
// 只能用「兩者級距太小」當代理指標抓出這種「懶得算、隨便抄一個數字」的情形。
const MIN_TP_TARGET_GAP_PCT = 0.015; // 停利跟目標價至少要差 1.5%，太接近就懷疑是隨便抄的

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

function checkPick(label, pick, limits, errors, warnings, requireFields, isMainPick, schemaVersion = 1) {
  if (!pick || !pick.symbol) return;
  const fieldNames = ['entry', 'take_profit', 'target', 'stop_loss'];
  const parsed = {};
  for (const key of fieldNames) {
    const raw = pick[key];
    if (raw === undefined) {
      // 2026-07-16 起 candidates 也要求有這四個結構化欄位（之前只寫在 plan_a 文字裡，
      // 健檢完全看不到，讓南亞、南亞科這種目標價抄錯的問題整整齊齊躲過了兩層防呆）
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

  // 2026-08-06 新增：500 元以上「市場觀察」區間定義上就是「買不起、僅供參考、不是可操作
  // 建議」（見 daily-report-prompt.md 第 8 步），下面 v2 那組「報酬風險比≥2／必填風控欄位」
  // 是為了真正會拿去下單的交易設計的可驗證門檻，硬套在「本來就說不是建議」的條目上是自相
  // 矛盾的要求——懷疑這是 8/5 報告生成卡死的根因之一：AI 為了湊出通過驗證的數字，在無上限
  // 的「改了重驗、還錯再改」迴圈裡一直卡住到沒時間 commit。這裡不對這個區間套用可交易性檢查，
  // 但漲跌停區間、進場/停損/目標的基本邏輯順序（不管哪個區間都適用）還是照樣驗證。
  const isMarketObservationOnly = Number.isFinite(parsed.entry) && computePriceTier(parsed.entry) === '500plus';

  // v2 把風控提升為機器可驗證欄位；v1 舊日報仍維持相容。市場觀察區間不適用（見上）。
  if (schemaVersion >= 2 && !isMarketObservationOnly) {
    for (const field of ['early_stop', 'risk_reward_ratio', 'invalidation_reason']) {
      if (!(field in pick) || pick[field] === '') {
        errors.push(`${label}（${pick.symbol || '無代號'}）缺少 v2 必填欄位 ${field}`);
      }
    }

    const rr = Number(pick.risk_reward_ratio);
    if (!Number.isFinite(rr) || rr < 2) {
      errors.push(`${label}（${pick.symbol || '無代號'}）risk_reward_ratio 必須至少為 2`);
    }

    if (pick.early_stop !== null && pick.early_stop !== undefined && pick.early_stop !== '') {
      const earlyStop = parsePrice(pick.early_stop);
      if (!Number.isFinite(earlyStop) || !Number.isFinite(parsed.entry) ||
          !Number.isFinite(parsed.stop_loss) || earlyStop <= parsed.stop_loss || earlyStop >= parsed.entry) {
        errors.push(`${label}（${pick.symbol || '無代號'}）early_stop 必須介於 stop_loss 與 entry 之間`);
      }
    }

    const priorChange = Number(pick.prior_day_change_pct);
    if (Number.isFinite(priorChange) && priorChange <= -7) {
      const strategyText = `${pick.plan_a || ''} ${pick.invalidation_reason || ''}`;
      if (!/09:15|9:15|九點十五/.test(strategyText)) {
        errors.push(`${label}（${pick.symbol || '無代號'}）前日重挫，策略必須明寫 09:15 前禁止做多`);
      }
    }
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

  // 邏輯順序檢查：停損 < 進場 < 目標（不管前收盤價查不查得到都能做，candidates 也要檢查）
  if (parsed.entry !== undefined && parsed.stop_loss !== undefined && parsed.stop_loss >= parsed.entry) {
    errors.push(`${label}（${pick.symbol} ${pick.name || ''}）停損價 ${parsed.stop_loss} 沒有低於進場價 ${parsed.entry}，邏輯不合理`);
  }
  if (parsed.entry !== undefined && parsed.target !== undefined && parsed.target <= parsed.entry) {
    errors.push(`${label}（${pick.symbol} ${pick.name || ''}）目標價 ${parsed.target} 沒有高於進場價 ${parsed.entry}，邏輯不合理`);
  }

  // 2026-07-16 新增（真實事故）：停利跟目標價擠在一起，通常代表目標價是隨便抄的（例如抄
  // 前一天的最高價），沒有根據今天真正的漲跌停區間重新算過。candidates 也要檢查，不是
  // 只有主推薦才查——南亞、南亞科這次的問題就是出在 candidates。
  if (parsed.take_profit !== undefined && parsed.target !== undefined) {
    const gapPct = (parsed.target - parsed.take_profit) / parsed.take_profit;
    if (gapPct < MIN_TP_TARGET_GAP_PCT) {
      errors.push(`${label}（${pick.symbol} ${pick.name || ''}）停利 ${parsed.take_profit} 跟目標 ${parsed.target} 只差 ${(gapPct * 100).toFixed(2)}%，太接近了，很可能是抄前一天高點沒有根據今天漲跌停重新計算`);
    }
  }
  if (limits && parsed.target !== undefined) {
    const usedUpside = (parsed.target - limits.prevClose) / (limits.upper - limits.prevClose);
    if (usedUpside < 0.5 && parsed.target < limits.upper * 0.95) {
      warnings.push(`${label}（${pick.symbol} ${pick.name || ''}）目標價 ${parsed.target} 只用到今天漲停空間（前收 ${limits.prevClose} 到漲停 ${limits.upper.toFixed(2)}）的 ${(usedUpside * 100).toFixed(0)}%，確認是不是抄了前一天的價位、沒有根據今天重新算`);
    }
  }

  // 2026-08-03 改：資金防呆套用到所有條目（含 candidates），並把結果寫成結構化欄位
  // 直接掛回 pick 物件上（picks 陣列裡存的是 report 內部物件的參照，這裡改了 main() 裡
  // 最後寫回 latest.json 時就會一併存進去），前端可以直接依 affordable 欄位分區塊渲染，
  // 不用再靠 LLM 有沒有記得在 risk_tag 文字裡提一句「成本較高」。
  if (parsed.entry !== undefined) {
    const perLotCost = Math.round(parsed.entry * 1000);
    pick.lot_cost_ntd = perLotCost;
    pick.affordable = perLotCost <= CAPITAL_CAP;
    if (!pick.affordable) {
      pick.capital_note = `單張成本約 ${Math.round(perLotCost / 10000)} 萬元，超過本金上限 ${CAPITAL_CAP / 10000} 萬元，僅供參考、非可操作建議`;
      warnings.push(`${label}（${pick.symbol} ${pick.name || ''}）單張成本約 ${Math.round(perLotCost / 10000)} 萬，超過本金上限 ${CAPITAL_CAP / 10000} 萬，已標記 affordable:false`);
    } else {
      pick.capital_note = null;
    }

    // 2026-08-04 新增：股價區間分類，覆蓋寫回，不管生成階段有沒有標對。
    const tier = computePriceTier(parsed.entry);
    pick.price_tier = tier;
    pick.market_observation_only = tier === '500plus';
    if (pick.market_observation_only && pick.affordable !== false) {
      // 理論上不該發生（500元entry×1000一定超過50萬CAPITAL_CAP），發生了代表兩條規則的
      // 門檻被改到不一致，寧可吵出來也不要讓500plus區塊悄悄混進「可操作」清單。
      warnings.push(`${label}（${pick.symbol} ${pick.name || ''}）price_tier=500plus 但 affordable 沒有同步標成 false，CAPITAL_CAP 門檻可能跟 500 元分界不一致，人工確認一下`);
    }
  }

  if (isMainPick && limits) {
    const nearLimitBound = limits.upper * NEAR_LIMIT_PCT;
    const nearLimitFields = Object.entries(parsed).filter(([, val]) => val >= nearLimitBound);
    if (nearLimitFields.length > 0) {
      const hasNote = /貼近漲停|鎖漲停|追價風險/.test(pick.risk_tag || '');
      if (!hasNote) {
        warnings.push(`${label}（${pick.symbol} ${pick.name || ''}）${nearLimitFields.map(([k]) => k).join('/')} 貼近漲停價（${limits.upper.toFixed(2)}），但 risk_tag 沒有註明追價風險，確認是否該降級為觀察`);
      }
    }
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

  // 2026-07-16 新增：今天休市（market_open: false）是合法狀態，不用照一般交易日的結構檢查，
  // 起因是 2026-07-10 颱風休市那天報告完全沒查交易日曆、照樣生出一份無效的進場建議。
  if (report.market_open === false) {
    console.log('今日休市（' + (report.market_closed_reason || '原因未註明') + '），略過一般交易日的結構健檢。');
    fs.writeFileSync(RESULT_PATH, JSON.stringify({ errors: [], warnings: [] }, null, 2));
    return;
  }

  // 結構檢查
  if (!report.date || report.date === '尚未產生') errors.push('date 欄位是預設值，報告還沒真的產生過');
  if (!report.generated_at) warnings.push('generated_at 是空的');
  // 2026-08-04 改：summary.safe_pick/aggressive_pick 固定2檔的舊結構，改成
  // summary.recommendations 變動長度陣列（依股價區間，夠格幾檔列幾檔，可以是0檔）。
  if (!report.summary || !Array.isArray(report.summary.recommendations)) {
    errors.push('summary.recommendations 不是陣列，報告結構跟新版schema不符');
  } else if (report.summary.recommendations.length === 0) {
    warnings.push('summary.recommendations 是空陣列，今天完全沒有任何區間有夠格的推薦，確認是不是真的市況太差、不是漏寫');
  }
  if (!Array.isArray(report.candidates) || report.candidates.length === 0) errors.push('candidates 是空陣列');

  // 日期新鮮度檢查（用台北時區判斷是不是今天，只警告不擋，因為可能是收假日補發的舊報告）
  if (report.date && report.date !== '尚未產生') {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // yyyy-mm-dd
    if (report.date !== today) {
      warnings.push(`report.date=${report.date} 跟今天（台北時間 ${today}）不一致，確認是不是忘記更新`);
    }
  }

  // 新聞多樣性檢查（2026-07-16 新增）：則數太少、或集中在同一個類別，只警告不擋
  const news = Array.isArray(report.news) ? report.news : [];
  if (news.length < MIN_NEWS_COUNT) {
    warnings.push(`news 只有 ${news.length} 則，建議至少 ${MIN_NEWS_COUNT} 則`);
  }
  const categories = new Set(news.map(n => n.category).filter(Boolean));
  if (categories.size > 0 && categories.size < MIN_NEWS_CATEGORIES) {
    warnings.push(`新聞只橫跨 ${categories.size} 個類別（${[...categories].join('、')}），建議至少 ${MIN_NEWS_CATEGORIES} 個不同類別，不要太集中`);
  }

  const picks = [];
  if (report.summary && Array.isArray(report.summary.recommendations)) {
    // [label, pick, requireFields, isMainPick]
    report.summary.recommendations.forEach((p, i) => {
      const typeLabel = p.type === 'aggressive' ? '衝最快' : p.type === 'safe' ? '安全牌' : '推薦';
      picks.push([`${typeLabel}#${i + 1}`, p, true, true]);
    });
  }
  // 2026-07-16 起 candidates 也要求有結構化的 entry/take_profit/target/stop_loss 欄位
  // （requireFields=true），但不是正式主推薦所以資金級距/貼近漲停降級不適用（isMainPick=false）
  (report.candidates || []).forEach((c, i) => picks.push([`候選#${c.rank || i + 1}`, c, true, false]));

  const limitsCache = {};
  for (const [label, pick, requireFields, isMainPick] of picks) {
    if (!pick.symbol) continue;
    if (!(pick.symbol in limitsCache)) {
      try {
        limitsCache[pick.symbol] = await fetchLimits(pick.symbol);
      } catch (e) {
        limitsCache[pick.symbol] = null;
      }
    }
    checkPick(label, pick, limitsCache[pick.symbol], errors, warnings, requireFields, isMainPick, Number(report.schema_version || 1));
  }

  console.log(`健檢完成：${picks.length} 檔，${errors.length} 個錯誤，${warnings.length} 個警告`);
  if (warnings.length) {
    console.log('\n--- 警告（不擋發布，但建議看一下）---');
    warnings.forEach(w => console.log('⚠ ' + w));
  }
  if (errors.length) {
    console.log('\n--- 錯誤（會擋發布，必須修正）---');
    errors.forEach(e => console.log('✗ ' + e));
  } else {
    console.log('\n沒有發現漲跌停或邏輯錯誤，可以發布。');
  }

  // 結構化結果另外寫一份檔案，給 GitHub Actions 那層「連得到網路的複核」讀取用，
  // 不用去 parse 印出來的文字（脆弱），2026-07-16 新增。
  fs.writeFileSync(RESULT_PATH, JSON.stringify({ errors, warnings }, null, 2));

  // 2026-08-03 新增：把上面 checkPick() 掛在每個 pick 物件上的 affordable/lot_cost_ntd/
  // capital_note 欄位寫回 latest.json。這段不需要網路（entry × 1000 是純數學），沙盒環境
  // 產生報告當下就會跑到、GitHub Actions 那次複核也會再跑一次（數字應該一致，不會產生
  // 多餘 commit，git diff 沒變化的話 workflow 的 commit 步驟會自己跳過）。
  if (!report.data_quality) report.data_quality = {};
  report.data_quality.capital_cap_ntd = CAPITAL_CAP;
  fs.writeFileSync(LATEST_PATH, JSON.stringify(report, null, 2) + '\n');

  if (errors.length) process.exit(1);
}

main().catch(e => {
  console.error('健檢腳本本身出錯：', e.message);
  fs.writeFileSync(RESULT_PATH, JSON.stringify({ errors: ['健檢腳本本身出錯：' + e.message], warnings: [] }, null, 2));
  process.exit(1);
});
