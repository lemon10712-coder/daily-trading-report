const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluatePickIntraday, analyzeRecommendation, buildStrategyReview } = require('../scripts/backtest');

const zeroCosts = { commissionRate: 0, sellTaxRate: 0, slippageRate: 0 };

test('台塑 1301 依序分批停損，不能用收盤價覆蓋', () => {
  const pick = { entry: '64.5-65.5', stop_loss: '63.0', take_profit: '68.0', target: '70.0', plan_a: '跌破63.8元先減碼一半；跌破63.0元全數出場。' };
  const bars = [
    { time: '09:00', open: 65, high: 65.2, low: 64.8, close: 65 },
    { time: '09:06', open: 64, high: 64.2, low: 63.6, close: 63.7 },
    { time: '09:38', open: 63.5, high: 63.5, low: 62.7, close: 62.9 },
    { time: '13:30', open: 62.8, high: 62.9, low: 62.8, close: 62.8 },
  ];
  const result = evaluatePickIntraday(pick, bars, zeroCosts);
  assert.equal(result.status, 'stop_loss');
  assert.equal(result.entry_price, 65);
  assert.equal(result.average_exit, 63.4);
  assert.equal(result.gross_pct, -2.46);
  assert.deepEqual(result.exits.map((item) => item.reason), ['early_stop', 'stop_loss']);
});

test('力積電 6770 全天未碰進場區必須是 no_trade', () => {
  const pick = { entry: '75.0-77.5', stop_loss: '72.5', take_profit: '80', target: '82' };
  const bars = [
    { time: '09:00', open: 72.4, high: 73.4, low: 72, close: 72.8 },
    { time: '13:30', open: 69, high: 69.1, low: 68.9, close: 68.9 },
  ];
  const result = evaluatePickIntraday(pick, bars, zeroCosts);
  assert.equal(result.status, 'no_trade');
  assert.equal(result.entry_triggered, false);
  assert.equal(result.gross_pct, 0);
});

test('同一分鐘同時碰停利與停損採保守停損', () => {
  const pick = { entry: '100-102', stop_loss: '98', take_profit: '106', target: '110' };
  const result = evaluatePickIntraday(pick, [{ time: '09:00', open: 101, high: 107, low: 97, close: 103 }], zeroCosts);
  assert.equal(result.status, 'ambiguous_stop');
  assert.equal(result.ambiguous, true);
  assert.equal(result.average_exit, 98);
});

test('推薦品質能辨識做多方向錯誤與進場位置不佳', () => {
  const pick = { entry: '100-102', stop_loss: '98', take_profit: '108', target: '110' };
  const bars = [
    { time: '09:00', open: 101, high: 102, low: 100, close: 101 },
    { time: '13:30', open: 96, high: 97, low: 94, close: 95 },
  ];
  const trade = evaluatePickIntraday(pick, bars, zeroCosts);
  const review = analyzeRecommendation(pick, trade, bars);
  assert.equal(review.direction, '錯誤');
  assert.equal(review.verdict, '需要改善');
  assert.ok(review.improvements.some((item) => item.includes('VWAP')));
});

test('整體策略評分會依股票代號去重', () => {
  const item = { symbol: '2303', quality_review: { score: 80, verdict: '正確', improvements: ['保留規則'] } };
  const review = buildStrategyReview({ picks: { safe_pick: item }, candidates: [item] });
  assert.equal(review.reviewed_symbols, 1);
  assert.equal(review.average_score, 80);
});
