/* Verification for backtest/engine.mjs and backtest/metrics.mjs.

   The goldens below are computed by hand in the comments, not by running
   the code and pasting what it said. A test that records current behaviour
   proves only that the behaviour has not changed, which is worth very
   little when the question is whether the behaviour was ever right.

   The load-bearing case is `fills at the next open`: it is the one bug that
   makes a backtester lie in the flattering direction, so it is tested with
   a gap so large that getting it wrong doubles the answer.

   Run: node backtest/engine.test.mjs                                      */

import { runBacktest, buyAndHold, LONG, FLAT, SHORT } from './engine.mjs';
import { computeMetrics, drawdown, barsPerYear } from './metrics.mjs';

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (name, actual, expected, tol = 1e-6) =>
  ok(name, actual != null && Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);
const throws = (name, fn) => {
  try { fn(); ok(name, false, 'did not throw'); } catch { ok(name, true); }
};
const section = s => console.log(`\n\x1b[1m${s}\x1b[0m`);

const DAY = 86400;
/* Bars from OHLC tuples; flat bars where only a close is given. */
const mk = rows => rows.map((r, i) => Array.isArray(r)
  ? { time: i * DAY, open: r[0], high: r[1], low: r[2], close: r[3], volume: 1000 }
  : { time: i * DAY, open: r, high: r, low: r, close: r, volume: 1000 });

const always = want => ({ name: `always ${want}`, decide: () => want });

/* ══ Fill timing — the one that matters ═════════════════════════════════ */
section('Fill timing');
{
  /* Decide LONG on bar 0's close (100). Bar 1 gaps to an open of 200.
     Correct: 100 000 / 200 = 500 shares, marked at 200 → equity unchanged.
     Wrong (filling at bar 0's close): 1 000 shares → equity 200 000. */
  const r = runBacktest(mk([100, 200]), always(LONG));
  eq('fills at next open, not this close', r.finalEquity, 100_000, 1e-6);
  eq('  shares reflect the gapped open', r.trades[0].entryPrice, 200);
}
{
  /* A decision on the last bar can never be acted on — there is no next
     bar to fill at. Two bars, long only from bar 1: nothing should trade. */
  const r = runBacktest(mk([100, 100]), { name: 'late', decide: c => c.i === 1 ? LONG : FLAT });
  eq('decision on the final bar never fills', r.fills, 0);
  eq('  and leaves equity untouched', r.finalEquity, 100_000);
}
throws('cursor refuses to look ahead', () =>
  runBacktest(mk([1, 2, 3]), { name: 'peek', decide: c => c.at(c.i + 1) ? LONG : FLAT }));
{
  const r = runBacktest(mk([10, 20, 30]), {
    name: 'prior', decide: c => { const p = c.prior(1); return p && c.bar.close > p.close ? LONG : FLAT; },
  });
  ok('prior() reaches backwards fine', r.fills > 0);
  throws('prior() rejects negative k', () =>
    runBacktest(mk([1, 2, 3]), { name: 'bad', decide: c => c.prior(-1) ? LONG : FLAT }));
}

/* ══ Accounting ═════════════════════════════════════════════════════════ */
section('Accounting');
{
  /* Buy and hold, frictionless. Entry at bar 1's open (110), exit forced at
     the last close (130): 130/110 − 1 = 18.1818…%  */
  const r = runBacktest(mk([100, 110, 120, 130]), buyAndHold);
  eq('buy and hold returns close/entry-open', r.finalEquity, 100_000 * 130 / 110, 1e-6);
  eq('  one round trip', r.fills, 2);
  eq('  one trade', r.trades.length, 1);
  ok('  final trade flagged as forced', r.trades[0].forced === true);
}
{
  /* Costs, hand-computed. 3 flat bars at 100, commission 10bp, slip 5bp.
     Entry  : exec 100.05, 1 000 sh → cash 100 000 − 100 050 − 100.05 = −150.05
     Exit   : exec  99.95         → cash −150.05 + 99 950 − 99.95 = 99 700  */
  const r = runBacktest(mk([100, 100, 100]), always(LONG), { commissionBps: 10, slippageBps: 5 });
  eq('commission and slippage land exactly', r.finalEquity, 99_700, 1e-6);
  eq('  commission booked', r.commissionPaid, 100.05 + 99.95, 1e-6);
  eq('  slippage booked', r.slippagePaid, 1000 * 0.05 * 2, 1e-6);
}
{
  /* Short a halving: −1 000 sh at 100 → cash 200 000; cover at 50 → 150 000 */
  const r = runBacktest(mk([100, 100, 50]), always(SHORT));
  eq('short profits as the price falls', r.finalEquity, 150_000, 1e-6);
  eq('  position is negative', r.trades[0].side, SHORT);
}
{
  const r = runBacktest(mk([100, 100, 50]), always(SHORT), { allowShort: false });
  eq('allowShort:false clamps to flat', r.finalEquity, 100_000);
  eq('  and never trades', r.fills, 0);
}
{
  const r = runBacktest(mk([100, 120, 90, 130]), always(FLAT));
  eq('flat strategy holds cash exactly', r.finalEquity, 100_000);
  eq('  no trades', r.trades.length, 0);
  ok('  exposure is zero', computeMetrics(r).exposure === 0);
}
{
  /* null means "hold", not "go flat" — the difference between an exit rule
     and the absence of one. */
  const r = runBacktest(mk([100, 100, 200]), {
    name: 'hold', decide: c => c.i === 0 ? LONG : null,
  });
  eq('null holds the position', r.finalEquity, 200_000, 1e-6);
  eq('  entered once, exited once', r.fills, 2);
}
throws('a bad decide() return is rejected', () =>
  runBacktest(mk([1, 2, 3]), { name: 'junk', decide: () => 'buy' }));
{
  /* Trade P&L is measured equity-to-equity, so the trades must account for
     the entire change in the account with nothing left over. */
  const bars = mk(Array.from({ length: 60 }, (_, i) => 100 + 30 * Math.sin(i / 2)));
  const r = runBacktest(bars, {
    name: 'zigzag',
    decide: c => { const p = c.prior(1); return p ? (c.bar.close > p.close ? LONG : SHORT) : FLAT; },
  }, { commissionBps: 5, slippageBps: 5 });
  const sum = r.trades.reduce((s, t) => s + t.pnl, 0);
  ok('many trades generated', r.trades.length > 8, `${r.trades.length}`);
  eq('trade P&L reconciles to the account', sum, r.finalEquity - r.initialCash, 1e-6);
}
{
  const r = runBacktest(mk([100, 100, 100]), always(LONG), { wholeShares: true });
  ok('wholeShares yields an integer position', Number.isInteger(r.trades[0].shares), `${r.trades[0].shares}`);
}
throws('too few bars is an error', () => runBacktest(mk([100]), buyAndHold));
throws('a strategy without decide() is an error', () => runBacktest(mk([1, 2]), { name: 'x' }));

/* ══ Metrics ════════════════════════════════════════════════════════════ */
section('Metrics');
{
  const d = drawdown([100, 120, 60, 90, 130]);
  eq('max drawdown is peak-to-trough', d.maxDrawdown, 0.5);
  const flat = drawdown([100, 100, 100]);
  eq('a flat curve has no drawdown', flat.maxDrawdown, 0);
  const down = drawdown([100, 90, 80, 70]);
  eq('a monotonic decline draws down to the end', down.maxDrawdown, 0.3, 1e-9);
  eq('  and stays underwater throughout', down.longestDrawdownBars, 3);
}
{
  const year = 365.2425 * DAY, N = 366;
  const m = computeMetrics({
    strategy: 'x', initialCash: 100_000,
    equity: Array.from({ length: N }, (_, i) => 100_000 * 2 ** (i / (N - 1))),
    bars: Array.from({ length: N }, (_, i) => ({ time: i * year / (N - 1) })),
    trades: [], position: Array(N).fill(1),
  });
  eq('doubling in one year is 100% CAGR', m.cagr, 1, 1e-6);
  eq('  total return agrees', m.totalReturn, 1, 1e-9);
}
{
  const bars = Array.from({ length: 253 }, (_, i) => ({ time: i * DAY }));
  /* 253 calendar-daily bars span a year, so ≈365 bars/yr — the inference
     is from the data, not an assumption of 252 trading days. */
  ok('bars/yr inferred from the data', Math.abs(barsPerYear(bars) - 365) < 3, `${barsPerYear(bars)}`);
  const weekdays = [];
  for (let d = 0, added = 0; added < 252; d++) {
    const dow = new Date(d * DAY * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) { weekdays.push({ time: d * DAY }); added++; }
  }
  /* 365.2425 * 5/7 = 260.9. The familiar 252 is what survives holidays, and
     this fixture has none — reporting 252 here would mean the function was
     assuming a calendar rather than reading one. */
  ok('weekday bars land near 261', Math.abs(barsPerYear(weekdays) - 260.9) < 3, `${barsPerYear(weekdays)}`);
}
{
  const m = computeMetrics({
    strategy: 'x', equity: [100, 110, 121], initialCash: 100,
    bars: [{ time: 0 }, { time: DAY }, { time: 2 * DAY }], trades: [], position: [1, 1, 1],
  });
  ok('constant returns give no Sharpe', m.sharpe === null, `${m.sharpe}`);
  ok('  volatility is zero, not null', m.volatility === 0, `${m.volatility}`);
}
{
  const trades = [{ pnl: 100, bars: 3 }, { pnl: -50, bars: 2 }, { pnl: 200, bars: 5 }, { pnl: -50, bars: 1 }];
  const m = computeMetrics({
    strategy: 'x', equity: [1000, 1200], initialCash: 1000,
    bars: [{ time: 0 }, { time: DAY }], trades, position: [1, 1],
  });
  eq('win rate counts winners', m.winRate, 0.5);
  eq('profit factor is gross win over gross loss', m.profitFactor, 300 / 100, 1e-9);
  eq('expectancy is mean P&L', m.expectancy, 50, 1e-9);
  eq('best trade', m.bestTrade, 200);
  eq('worst trade', m.worstTrade, -50);
  eq('avg bars held', m.avgBarsHeld, 2.75, 1e-9);
}
{
  /* A losing rule must not be rescued by the arithmetic. */
  const r = runBacktest(mk([100, 100, 90, 81]), always(LONG));
  const m = computeMetrics(r);
  ok('a losing rule reports a loss', m.totalReturn < 0, `${m.totalReturn}`);
  ok('  negative CAGR', m.cagr < 0);
  ok('  drawdown is positive', m.maxDrawdown > 0);
}

/* ══ End to end on synthetic-but-realistic bars ═════════════════════════ */
section('End to end');
{
  /* Deterministic geometric random walk — seeded, so a failure here is
     reproducible rather than a once-a-month mystery. */
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const bars = []; let px = 100;
  for (let i = 0; i < 1500; i++) {
    const o = px, c = o * (1 + (rnd() - 0.5) * 0.04);
    bars.push({ time: i * DAY, open: o, high: Math.max(o, c) * 1.005, low: Math.min(o, c) * 0.995, close: c, volume: 1e6 });
    px = c;
  }
  const sma = (src, n) => src.map((_, i) => i < n - 1 ? null
    : src.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  const cross = {
    name: 'SMA 20/50',
    prepare: b => ({ f: sma(b.map(x => x.close), 20), s: sma(b.map(x => x.close), 50) }),
    decide: (c, ctx) => {
      const f = ctx.f[c.i], s = ctx.s[c.i];
      return (f == null || s == null) ? FLAT : (f > s ? LONG : FLAT);
    },
  };
  const r = runBacktest(bars, cross, { commissionBps: 5, slippageBps: 5 });
  const m = computeMetrics(r);
  ok('runs on 1 500 bars', r.equity.length === 1500);
  ok('  equity is finite throughout', r.equity.every(Number.isFinite));
  ok('  never goes negative', r.equity.every(v => v > 0));
  ok('  trades were taken', r.trades.length > 5, `${r.trades.length}`);
  ok('  exposure is partial', m.exposure > 0 && m.exposure < 1, `${m.exposure}`);
  eq('  P&L reconciles', r.trades.reduce((s, t) => s + t.pnl, 0), r.finalEquity - r.initialCash, 1e-6);
  ok('  costs were charged', r.commissionPaid > 0 && r.slippagePaid > 0);

  /* Costs can only hurt. If a "cheaper" run ever loses to a dearer one the
     cost model is being applied somewhere it should not be. */
  const free = runBacktest(bars, cross);
  ok('  costs reduce the result', free.finalEquity > r.finalEquity);
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
