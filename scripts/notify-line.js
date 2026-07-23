// Broadcast a plain-text message to the LINE Official Account's followers
// (currently just the account owner). Uses LINE_CHANNEL_ACCESS_TOKEN from
// the environment; never hardcode the token here.
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const message = process.argv[2];

if (!message) {
  console.error('Usage: node notify-line.js "<message text>"');
  process.exit(1);
}
if (!token) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN is not set; skipping LINE notification.');
  process.exit(0); // Missing token shouldn't fail the whole workflow run.
}

async function main() {
  const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages: [{ type: 'text', text: message.slice(0, 4900) }] })
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`LINE broadcast failed (${res.status}): ${body}`);
    process.exit(1);
  }
  console.log('LINE notification sent.');
}

main();
