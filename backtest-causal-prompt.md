# 收盤後個股因果分析 — 雲端自動生成版（2026-07-28 新增）

你在一個全新的雲端沙盒環境執行，**沒有瀏覽器、沒有 Playwright**。只能用 Bash（curl、node）、WebFetch、WebSearch。這份文件已經內建完整方法論，不用參考其他地方。

## 背景與目的

`scripts/backtest.js` 已經在你之前跑過，把今天的進場/出場結果、OHLC 數字寫進 `data/backtest-latest.json`，裡面每檔的 `quality_review.reasons` 目前只是**模板化文字**（例如「做多方向錯誤：收盤相對開盤 -1.07%」——這只是把數字重講一次，不是真正的因果解釋）。

使用者明確要求：**每一檔股票的漲跌都要有真正查證過的原因**，不能只有這種模板句。這件事無法寫進 `backtest.js`（它是純 Node 腳本，沒有 WebSearch 能力），所以另外用這個雲端 agent 補上。

## 執行步驟

1. 讀取 `data/backtest-latest.json`，確認今天的 `date` 欄位。
2. 對 `picks.safe_pick`、`picks.aggressive_pick`，以及 `candidates` 陣列裡**有觸發進場**（`entry_triggered === true`）或**當日振幅／漲跌幅明顯**（`quality_review.market.range_pct >= 4` 或 `Math.abs(close_pct) >= 3`）的每一檔，用 WebSearch 查證「[股票名稱] [日期] 為什麼漲」或「[股票名稱] [日期] 為什麼跌」「[股票名稱] 消息面」，找出真正的驅動原因：
   - 個股層級：法說會、目標價調整、訂單/產能消息、董監事持股變動、謠言與闢謠公告
   - 類股層級：同族群競爭者的消息（例如同業財報、同業停產）、產業趨勢報告（例如 DRAM 漲跌價、AI 供應鏈消息）
   - 總經/國際層級：美股/費半(SOX)/台積電ADR的連動、地緣政治、政策
   - 查不到具體原因：老實寫「查無明確驅動消息，可能是大盤/類股連動或籌碼面因素」，**不要編造**。
3. 把查到的結果寫進每檔的 `quality_review` 底下新增一個欄位：
   ```json
   "causal_analysis": {
     "summary": "一到兩句話講清楚真正的漲跌原因，具體到誰說了什麼/發生什麼",
     "category": "個股消息 | 類股連動 | 總經國際 | 籌碼面 | 查無明確原因",
     "sources_note": "簡短描述查到的來源類型，例如「法人報告＋官方公告」，不用附完整URL"
   }
   ```
4. 同時在 `result`（`backtest-latest.json` 最上層）新增一個 `causal_analysis_generated_at` 時間戳欄位（`YYYY-MM-DD HH:MM` 台北時間），方便之後判斷這份因果分析是不是最新的。
5. 把更新後的 JSON 寫回 `data/backtest-latest.json`，同時同步寫回 `data/backtest/{date}.json`（跟 `backtest-latest.json` 內容一致）。
6. Commit 並 push：
   ```bash
   git config user.name "backtest-causal-bot"
   git config user.email "backtest-causal-bot@users.noreply.github.com"
   git add data/backtest-latest.json data/backtest/
   git diff --cached --quiet && exit 0
   git commit -m "Causal analysis for $(date +%Y-%m-%d)"
   for attempt in 1 2 3; do
     git pull --rebase && git push && exit 0
     sleep $((attempt * 10))
   done
   exit 1
   ```
7. **只有在第 6 步真的產生新 commit（有東西可推）時**，才通知使用者因果分析已經好了。**重要：這個雲端 routine 跟 GitHub Actions 是不同的執行環境，拿不到 `LINE_CHANNEL_ACCESS_TOKEN`（那是存在 GitHub Actions secrets 裡的），而且這個 repo 是 public 的，絕對不能把任何 token 明碼寫進 commit 裡。正確做法是呼叫 GitHub API，觸發本來就有權限存取那組 secret 的 `notify-line-manual.yml` workflow**：
   ```bash
   node -e "
   const fs = require('fs');
   const d = JSON.parse(fs.readFileSync('data/backtest-latest.json','utf8'));
   const lines = [];
   for (const key of ['safe_pick','aggressive_pick']) {
     const p = d.picks && d.picks[key];
     const c = p && p.quality_review && p.quality_review.causal_analysis;
     if (p && c) lines.push(p.name + '(' + p.symbol + ')：' + c.summary);
   }
   const msg = '🔍 今天的個股漲跌原因查好了：\n' + (lines.join('\n') || '（今天兩檔皆未觸發進場，無漲跌原因可查）');
   fs.writeFileSync('/tmp/line-msg.txt', msg);
   "
   # SECURITY: never hardcode the token in this file (it's committed to a PUBLIC repo).
   # Extract it at runtime from the git remote URL you already configured for step 6's push
   # (the routine's own prompt message sets that remote with the token as the HTTPS password —
   # it lives in the private routine config, never in a committed file).
   TOKEN=$(git remote get-url origin | sed -E 's#https://[^:]+:([^@]+)@.*#\1#')
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/lemon10712-coder/daily-trading-report/actions/workflows/notify-line-manual.yml/dispatches \
     -d "$(node -e "console.log(JSON.stringify({ref:'main', inputs:{message: require('fs').readFileSync('/tmp/line-msg.txt','utf8')}}))")"
   ```
   If this API call fails (e.g. 403 because the token lacks Actions:write scope), just print the failure and move on — **do not let a failed notification block the task**. The causal analysis already being committed and pushed in step 6 is this routine's real output; the LINE ping is a nice-to-have on top.

## 品質要求（比照日報方法論）

- **不要為了填滿欄位硬掰因果關係**——查不到具體消息，老實寫「查無明確驅動消息」，這是可以接受的答案，比編一個聽起來合理但沒查證的原因好得多。
- 如果 `data/backtest-latest.json` 的 `date` 不是今天，或這份資料已經有 `causal_analysis_generated_at` 且晚於 `backtest.js` 最後寫入時間（代表已經跑過，不用重跑），直接結束不用做任何事。
- 這份工作是為了讓之後的人工回測報告（例如每週/每次使用者要求的深度回測）能直接引用已經查證好的因果分析，不用每次重新查一遍。
