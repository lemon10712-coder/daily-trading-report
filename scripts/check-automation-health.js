const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
const now = process.env.HEALTH_NOW ? new Date(process.env.HEALTH_NOW) : new Date();
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hour12: false,
}).formatToParts(now);
const get = (type) => parts.find((item) => item.type === type)?.value;
const today = `${get('year')}-${get('month')}-${get('day')}`;
const hour = Number(get('hour'));
const report = read('latest.json');
const pdf = fs.existsSync(path.join(DATA, 'pdf-latest.json')) ? read('pdf-latest.json') : {};
const backtest = fs.existsSync(path.join(DATA, 'backtest-latest.json')) ? read('backtest-latest.json') : {};
const failures = [];

if (report.date !== today) failures.push(`latest.json is ${report.date}, expected ${today}`);
if (pdf.date !== today || !pdf.morning_pdf) failures.push('morning PDF is missing or stale');
if (hour >= 15 && report.market_open !== false) {
  if (backtest.date !== today || Number(backtest.schema_version) < 2) failures.push('schema v2 intraday backtest is missing or stale');
  if (pdf.date !== today || !pdf.final_pdf) failures.push('final PDF with backtest is missing or stale');
}

if (failures.length) {
  console.error(`CHARLES AGENT automation health FAILED (${today} ${hour}:00 Asia/Taipei)`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`CHARLES AGENT automation health OK (${today} ${hour}:00 Asia/Taipei)`);
