const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'strategy-learning.json');

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function dailySnapshot(backtest) {
  const unique = new Map();
  for (const item of [...Object.values(backtest.picks || {}), ...(backtest.candidates || [])].filter(Boolean)) {
    if (!unique.has(item.symbol)) unique.set(item.symbol, item);
  }
  const items = [...unique.values()];
  const reviewed = items.filter((item) => Number.isFinite(item.quality_review?.score));
  const mainPicks = Object.values(backtest.picks || {}).filter(Boolean);
  const triggered = mainPicks.filter((item) => item.entry_triggered);
  return {
    date: backtest.date,
    recorded_at: new Date().toISOString(),
    reviewed_symbols: reviewed.length,
    average_score: backtest.strategy_review?.average_score ?? null,
    verdict: backtest.strategy_review?.verdict || '尚未評分',
    direction_correct: reviewed.filter((item) => item.quality_review.direction === '正確').length,
    direction_wrong: reviewed.filter((item) => item.quality_review.direction === '錯誤').length,
    main_pick_count: mainPicks.length,
    main_pick_triggered: triggered.length,
    main_pick_wins: triggered.filter((item) => Number(item.net_pct) > 0).length,
    main_pick_losses: triggered.filter((item) => Number(item.net_pct) < 0).length,
    lessons: (backtest.strategy_review?.priority_improvements || []).map((item) => ({
      rule: item.rule,
      affected_symbols: Number(item.affected_count || 0),
    })),
  };
}

function rebuildSummary(history) {
  const daily = history.daily_reviews;
  const scored = daily.filter((item) => Number.isFinite(item.average_score));
  const lessonMap = new Map();
  for (const day of daily) {
    for (const lesson of day.lessons || []) {
      const current = lessonMap.get(lesson.rule) || {
        rule: lesson.rule, occurrence_days: 0, affected_symbols_total: 0,
        first_seen: day.date, last_seen: day.date,
      };
      current.occurrence_days += 1;
      current.affected_symbols_total += lesson.affected_symbols || 0;
      if (day.date < current.first_seen) current.first_seen = day.date;
      if (day.date > current.last_seen) current.last_seen = day.date;
      lessonMap.set(lesson.rule, current);
    }
  }
  const recurring = [...lessonMap.values()].map((item) => ({
    ...item,
    status: daily.length >= history.minimum_days_before_rule_change && item.occurrence_days >= 5
      ? 'eligible_for_review'
      : item.occurrence_days >= 3 ? 'candidate_rule' : 'observation',
  })).sort((a, b) => b.occurrence_days - a.occurrence_days || b.affected_symbols_total - a.affected_symbols_total);
  history.summary = {
    trading_days: daily.length,
    average_strategy_score: scored.length ? round(scored.reduce((sum, item) => sum + item.average_score, 0) / scored.length, 1) : null,
    total_reviewed_symbols: daily.reduce((sum, item) => sum + item.reviewed_symbols, 0),
    main_pick_count: daily.reduce((sum, item) => sum + item.main_pick_count, 0),
    main_pick_triggered: daily.reduce((sum, item) => sum + item.main_pick_triggered, 0),
    main_pick_wins: daily.reduce((sum, item) => sum + item.main_pick_wins, 0),
    main_pick_losses: daily.reduce((sum, item) => sum + item.main_pick_losses, 0),
    direction_correct: daily.reduce((sum, item) => sum + item.direction_correct, 0),
    direction_wrong: daily.reduce((sum, item) => sum + item.direction_wrong, 0),
  };
  history.recurring_lessons = recurring;
  return history;
}

function updateStrategyLearning(backtest, outputPath = DEFAULT_PATH) {
  if (!backtest?.date || Number(backtest.schema_version) < 3 || !backtest.strategy_review) return null;
  let history = {
    schema_version: 1,
    minimum_days_before_rule_change: 20,
    rule_promotion_threshold_days: 5,
    policy: 'Record every day; promote only repeated lessons after enough trading days to reduce overfitting.',
    daily_reviews: [], recurring_lessons: [], summary: {},
  };
  if (fs.existsSync(outputPath)) history = { ...history, ...JSON.parse(fs.readFileSync(outputPath, 'utf8')) };
  const snapshot = dailySnapshot(backtest);
  const previous = (history.daily_reviews || []).find((item) => item.date === snapshot.date);
  if (previous) snapshot.recorded_at = previous.recorded_at;
  if (previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return history;
  history.daily_reviews = (history.daily_reviews || []).filter((item) => item.date !== snapshot.date);
  history.daily_reviews.push(snapshot);
  history.daily_reviews.sort((a, b) => a.date.localeCompare(b.date));
  history.updated_at = new Date().toISOString();
  rebuildSummary(history);
  const tempPath = `${outputPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(history, null, 2)}\n`);
  fs.renameSync(tempPath, outputPath);
  return history;
}

module.exports = { dailySnapshot, rebuildSummary, updateStrategyLearning };
