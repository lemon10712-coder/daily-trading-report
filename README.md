# 台股當沖報告網站

給李嘉和用的每日台股當沖推薦報告，手機板網頁，透過 GitHub Pages 免費託管。

## 架構

- `index.html` — 手機板網頁（杏色主題），讀取 `data/latest.json` 與 `data/prices.json` 顯示。
- `data/latest.json` — 每日選股報告（含結論、完整排行、新聞分析），由每天早上 8:30 的雲端排程 agent 產生並覆寫。
- `data/prices.json` — 開盤後每 5 分鐘更新一次的即時股價，由 GitHub Actions（`.github/workflows/refresh-prices.yml`）產生，抓證交所公開報價 API，不使用 AI。
- `.github/workflows/refresh-prices.yml` — GitHub Actions 排程，Mon-Fri 台股開盤時間內每 5 分鐘跑一次。
- `daily-report-prompt.md` — 每日 8:30 雲端排程 agent 使用的完整自給自足指令（方法論從 `daily-daytrading-report` skill 搬過來，改寫成不依賴本機環境）。
- `scripts/validate-report.js` — 發布前健檢腳本，拿每檔進場/停利/目標/停損價跟證交所當天官方漲跌停價比對，抓「漲停算錯」這類錯誤；`daily-report-prompt.md` 規定 commit 前一定要先跑過、沒有錯誤才能 push。

## 免費資源

- GitHub Pages：免費，流量遠低於軟限制（約 100GB/月）。
- GitHub Actions：public repo 免費無限額度（有使用上的合理限制，但這種輕量排程完全用不到）。
- 每日報告生成：透過 Claude Code 雲端排程 agent（不是另外的 API 費用）。
