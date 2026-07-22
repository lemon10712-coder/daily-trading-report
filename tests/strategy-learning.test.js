const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dailySnapshot, rebuildSummary, updateStrategyLearning } = require('../scripts/strategy-learning');

const lesson = '開盤跌破 VWAP 時取消做多';
const backtest = {
  schema_version: 3,
  date: '2026-07-22',
  picks: {
    safe_pick: { symbol: '2303', entry_triggered: false, quality_review: { score: 20, direction: '錯誤' } },
    aggressive_pick: { symbol: '2408', entry_triggered: true, net_pct: 2, quality_review: { score: 70, direction: '正確' } },
  },
  candidates: [{ symbol: '2303', quality_review: { score: 20, direction: '錯誤' } }],
  strategy_review: { average_score: 45, verdict: '整體需要改善', priority_improvements: [{ rule: lesson, affected_count: 2 }] },
};

test('每日學習快照會依股票代號去重並保留主推薦成效', () => {
  const snapshot = dailySnapshot(backtest);
  assert.equal(snapshot.reviewed_symbols, 2);
  assert.equal(snapshot.main_pick_triggered, 1);
  assert.equal(snapshot.main_pick_wins, 1);
  assert.equal(snapshot.lessons[0].rule, lesson);
});

test('教訓未累積足夠天數前不會自動升級成正式規則', () => {
  const history = { minimum_days_before_rule_change: 20, daily_reviews: [] };
  for (let day = 1; day <= 5; day += 1) history.daily_reviews.push({ ...dailySnapshot(backtest), date: `2026-07-${String(day).padStart(2, '0')}` });
  rebuildSummary(history);
  assert.equal(history.recurring_lessons[0].status, 'candidate_rule');
});

test('滿 20 天且同一教訓至少出現 5 天才可進人工審查', () => {
  const base = dailySnapshot(backtest);
  const history = { minimum_days_before_rule_change: 20, daily_reviews: [] };
  for (let day = 1; day <= 20; day += 1) history.daily_reviews.push({ ...base, date: `2026-06-${String(day).padStart(2, '0')}`, lessons: day <= 5 ? base.lessons : [] });
  rebuildSummary(history);
  assert.equal(history.recurring_lessons[0].status, 'eligible_for_review');
});

test('同一天相同回測重跑不改寫學習檔', () => {
  const output = path.join(os.tmpdir(), `strategy-learning-${Date.now()}.json`);
  updateStrategyLearning(backtest, output);
  const first = fs.readFileSync(output, 'utf8');
  updateStrategyLearning(backtest, output);
  const second = fs.readFileSync(output, 'utf8');
  assert.equal(second, first);
});
