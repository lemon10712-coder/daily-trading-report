// 只在 GitHub Actions 環境跑：這裡連得到證交所 API（跟 refresh-prices.js 用同一個環境），
// 是雲端沙盒生成報告時做不到的「真正連網複核」。讀 validate-report.js 剛剛寫出的
// .validate-result.json，如果有真的抓到錯誤，就把它顯眼地補進 data_quality.warnings，
// 並把 provisional 設成 true，讓網站上會出現「暫定，待更新」的提示——
// 不自動幫你改數字（改股價/進出場價這種財務數字不該由腳本自作主張），只負責誠實標出來。
const fs = require('fs');
const path = require('path');

const RESULT_PATH = path.join(__dirname, '..', '.validate-result.json');
const LATEST_PATH = path.join(__dirname, '..', 'data', 'latest.json');
const FLAG_MARKER = '🚨 GitHub Actions 連網複核';

function main() {
  if (!fs.existsSync(RESULT_PATH)) {
    console.log('沒有 .validate-result.json，略過。');
    return;
  }
  const result = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
  const errors = result.errors || [];
  if (errors.length === 0) {
    console.log('連網複核沒有發現錯誤，不用補警示。');
    return;
  }

  const report = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
  if (!report.data_quality) report.data_quality = {};
  if (!Array.isArray(report.data_quality.warnings)) report.data_quality.warnings = [];

  // 避免同一批錯誤被重複補上去（例如這支腳本本身的 commit 又觸發一次 workflow）
  const alreadyFlagged = report.data_quality.warnings.some(w => w.startsWith(FLAG_MARKER));
  if (alreadyFlagged) {
    console.log('已經標記過了，不重複補。');
    return;
  }

  const flagText = `${FLAG_MARKER}（雲端沙盒環境連不到證交所 API 時無法驗證，這裡改用有網路的 GitHub Actions 重新查證）發現以下問題，開盤前務必人工複核：${errors.join('；')}`;
  report.data_quality.warnings.unshift(flagText);
  report.provisional = true;

  fs.writeFileSync(LATEST_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log('已補上警示並設為 provisional。');
}

main();
