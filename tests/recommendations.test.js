const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateReportPicks, buildNarrative } = require('../scripts/backtest');
const { dailySnapshot } = require('../scripts/strategy-learning');

test('modern recommendations flow into narrative and learning without counting all candidates', async () => {
  const recommendations = [{ symbol: '1234', entry: '100' }, { symbol: '5678', entry: '200' }];
  const calls = [];
  const picks = await evaluateReportPicks({ date: '2026-10-02', summary: { recommendations }, candidates: [{ symbol: '9999' }] }, null, async (pick, date) => {
    calls.push([pick.entry, date]);
    return { symbol: pick.symbol, name: pick.symbol, entry_triggered: true, status: 'take_profit', net_pct: 2, label: 'win', quality_review: { score: 80, direction: '正確' } };
  });
  assert.equal(Object.keys(picks).length, 2);
  assert.deepEqual(calls, [['100', '2026-10-02'], ['200', '2026-10-02']]);
  const result = { picks, candidates: [], strategy_review: { average_score: 80 } };
  assert.match(buildNarrative(result), /推薦 2 檔，實際觸發 2 檔/);
  assert.equal(dailySnapshot(result).main_pick_count, 2);
  assert.equal(dailySnapshot(result).main_pick_wins, 2);
});

test('legacy picks remain supported and explicit empty modern list remains empty', async () => {
  const evaluate = async pick => pick;
  const legacy = { safe_pick: { symbol: '1234' }, aggressive_pick: { symbol: '5678' } };
  assert.deepEqual(await evaluateReportPicks({ summary: legacy }, null, evaluate), legacy);
  assert.deepEqual(await evaluateReportPicks({ summary: { ...legacy, recommendations: [] } }, null, evaluate), {});
  assert.equal(Object.keys(await evaluateReportPicks({ summary: { recommendations: [{ symbol: '1234' }, { symbol: '1234' }, null] } }, null, evaluate)).length, 1);
});
