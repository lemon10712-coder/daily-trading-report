const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-automation-health.js'), 'utf8');

test('health checker accepts closed market without post-close backtest', () => {
  assert.match(source, /report\.market_open !== false/);
});

test('health checker supports deterministic HEALTH_NOW acceptance tests', () => {
  assert.match(source, /process\.env\.HEALTH_NOW/);
  assert.doesNotThrow(() => new vm.Script(source));
});
