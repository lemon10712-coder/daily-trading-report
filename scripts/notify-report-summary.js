// Push a condensed version of today's morning report to LINE.
//
// Added 2026-08-05. Until now the report was only ever published to the web
// page — nothing pushed it anywhere, so a missing or late report was only
// noticeable by opening the site. The LINE channel already existed for health
// alerts; this puts the report itself on the same channel.
//
// Exits 0 without sending when latest.json is not today's, so a stale report
// is never broadcast as if it were current. The health check is what reports
// that as a failure.
const fs = require('fs');
const path = require('path');

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DATA = path.join(__dirname, '..', 'data');

const taipeiParts = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((item) => item.type === type)?.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
};

const { day: today } = taipeiParts(process.env.SUMMARY_NOW ? new Date(process.env.SUMMARY_NOW) : new Date());
const report = JSON.parse(fs.readFileSync(path.join(DATA, 'latest.json'), 'utf8'));

if (report.date !== today) {
  console.log(`latest.json is ${report.date}, not today (${today}); skipping summary push.`);
  process.exit(0);
}

const lines = [`台股當沖早報 ${report.date}`, ''];

if (report.provisional) lines.push('[暫定版] 部分資料尚未定案', '');
if (report.market_open === false) lines.push('今日休市', '');

// risk_tag runs to several hundred characters per pick — readable on the web
// page, unreadable as a phone notification. Keep only the first clause so the
// warning still registers, and point at the site for the full reasoning.
const firstClause = (text) => {
  const clause = String(text).split(/[；;]/)[0].trim();
  return clause.length > 38 ? `${clause.slice(0, 38)}…` : clause;
};

// Trim a longer causal statement (sentiment factor / narrative timeline text)
// to a phone-readable length without cutting it as aggressively as risk_tag —
// this is the actual content the user asked to receive, not just a flag.
const trimLong = (text, max) => {
  const s = String(text).trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const sentiment = report.sentiment || {};
if (sentiment.score !== undefined) {
  lines.push(`【今日多空】${sentiment.score}／100　${String(sentiment.label || '').split('（')[0]}`, '');
  (sentiment.factors || []).forEach((factor) => {
    const mark = factor.type === 'bull' ? '多' : factor.type === 'bear' ? '空' : '平';
    lines.push(`[${mark}] ${trimLong(factor.text, 130)}`);
  });
  if ((sentiment.factors || []).length) lines.push('');
}

const narrative = (report.narrative_timeline || []).find((item) => item.current) || (report.narrative_timeline || []).slice(-1)[0];
if (narrative) {
  lines.push(`【產業敘事】${narrative.date}`);
  lines.push(trimLong(narrative.text, 200), '');
}

const picks = (report.candidates || []).slice(0, 3);
if (picks.length) {
  lines.push(`【今日候選 前 ${picks.length} 檔／共 ${(report.candidates || []).length} 檔】`);
  picks.forEach((pick) => {
    lines.push(`${pick.rank}. ${pick.symbol} ${pick.name}　${pick.category || ''}`.trim());
    lines.push(`　進 ${pick.entry}／利 ${pick.take_profit}／損 ${pick.stop_loss}`);
    if (pick.risk_tag) lines.push(`　⚠ ${firstClause(pick.risk_tag)}`);
  });
  lines.push('');
}

const warnings = (report.data_quality || {}).warnings || [];
if (warnings.length) {
  lines.push(`【查證警告 ${warnings.length} 則】內容較長，請開網站看完整版`, '');
}

lines.push('完整報告：https://lemon10712-coder.github.io/daily-trading-report/');
lines.push('');
lines.push('提醒：進場價位以開盤後實際成交為準，開高跳空時原價位帶可能已失效。');

const message = lines.join('\n').slice(0, 4900);

if (!token) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN is not set; printing summary instead of sending.');
  console.log(message);
  process.exit(0);
}

async function main() {
  const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ type: 'text', text: message }] }),
  });
  if (!res.ok) {
    console.error(`LINE broadcast failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Report summary pushed to LINE (${message.length} chars).`);
}

main();
