/* Verification for resting orders (engine.mjs) and the monthly-bounce rules
   (strategies.mjs), against bars built by hand so the right answer is known
   before the code runs.

   Run: node backtest/strategy.test.mjs                                    */

import { runBacktest, LONG, FLAT, SHORT } from './engine.mjs';
import { monthlyBounce } from './strategies.mjs';
import { parseUniverse, makeScreen } from './universe.mjs';
import { poolTrades, simulatePortfolio } from './scan.mjs';

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (name, actual, expected, tol = 1e-6) =>
  ok(name, actual != null && Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);
const section = s => console.log(`\n\x1b[1m${s}\x1b[0m`);

const T = d => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
const bar = (d, o, h, l, c, raw) => ({
  time: T(d), open: o, high: h, low: l, close: c, volume: 1e6,
  raw: raw ?? { open: o, high: h, low: l, close: c },
});
/* Signal on bar `at`, so the fill lands on bar at+1's open. */
const bracketAt = (at, target, stop, side = LONG) => ({
  name: 'bracket',
  decide: (c, _x, pos) => pos !== FLAT ? null : (c.i === at ? { position: side, target, stop } : FLAT),
});

/* ══ Resting orders ═════════════════════════════════════════════════════ */
section('Resting orders');
{
  /* Enter at bar 1's open (100). Bar 2 trades up through 110. */
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 101, 99, 100),
                bar('2021-01-06', 100, 115, 99, 101)];
  const r = runBacktest(bars, bracketAt(0, 110, 90));
  eq('limit fills at the target, not the close', r.trades[0].exitPrice, 110);
  ok('  reason recorded', r.trades[0].exitReason === 'target', r.trades[0].exitReason);
  eq('  and the account reflects it', r.finalEquity, 100_000 * 110 / 100, 1e-6);
}
{
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 101, 99, 100),
                bar('2021-01-06', 100, 101, 85, 88)];
  const r = runBacktest(bars, bracketAt(0, 110, 90));
  eq('stop fills at the stop, not the close', r.trades[0].exitPrice, 90);
  ok('  reason recorded', r.trades[0].exitReason === 'stop', r.trades[0].exitReason);
}
{
  /* One bar touches both. OHLC cannot say which came first, so the stop is
     assumed — the alternative is a backtest that flatters itself. */
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 101, 99, 100),
                bar('2021-01-06', 100, 120, 85, 100)];
  const r = runBacktest(bars, bracketAt(0, 110, 90));
  eq('a bar touching both takes the stop', r.trades[0].exitPrice, 90);
  ok('  reason is stop', r.trades[0].exitReason === 'stop');
}
{
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 101, 99, 100),
                bar('2021-01-06', 130, 135, 128, 130)];
  const r = runBacktest(bars, bracketAt(0, 110, 90));
  eq('a gap through the target fills at the open', r.trades[0].exitPrice, 130);
  ok('  which is better than the limit', r.trades[0].exitPrice > 110);
}
{
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 101, 99, 100),
                bar('2021-01-06', 70, 75, 68, 70)];
  const r = runBacktest(bars, bracketAt(0, 110, 90));
  eq('a gap through the stop fills at the open', r.trades[0].exitPrice, 70);
  ok('  which is worse than the stop', r.trades[0].exitPrice < 90);
}
{
  /* The order is live the instant the position is: entry at bar 1's open,
     target hit inside that same bar. */
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 118, 99, 105),
                bar('2021-01-06', 105, 106, 104, 105)];
  const r = runBacktest(bars, bracketAt(0, 110, 90));
  eq('the order is live on the entry bar', r.trades[0].exitIdx, 1);
  eq('  filled at the target', r.trades[0].exitPrice, 110);
}
{
  /* A rule still saying "hold" must not keep the position alive after the
     order filled, nor silently re-enter on the next bar. */
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 101, 99, 100),
                bar('2021-01-06', 100, 115, 99, 112), bar('2021-01-07', 112, 130, 111, 128),
                bar('2021-01-08', 128, 140, 127, 138)];
  const r = runBacktest(bars, { name: 'hold-forever',
    decide: (c, _x, pos) => c.i === 0 ? { position: LONG, target: 110, stop: 90 } : null });
  eq('exactly one trade after the order fills', r.trades.length, 1);
  eq('  no re-entry on the rally that followed', r.finalEquity, 100_000 * 110 / 100, 1e-6);
}
{
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 101, 99, 100),
                bar('2021-01-06', 100, 101, 85, 88)];
  const r = runBacktest(bars, bracketAt(0, 90, 110, SHORT));
  eq('short target fills on the way down', r.trades[0].exitPrice, 90);
  eq('  and pays', r.finalEquity, 100_000 * (1 + (100 - 90) / 100), 1e-6);
}
{
  const bars = [bar('2021-01-04', 100, 100, 100, 100), bar('2021-01-05', 100, 101, 99, 100),
                bar('2021-01-06', 100, 115, 99, 112)];
  const r = runBacktest(bars, bracketAt(0, 90, 110, SHORT));
  eq('short stop fills on the way up', r.trades[0].exitPrice, 110);
  ok('  and loses', r.finalEquity < 100_000);
}

/* ══ The rules as specified ═════════════════════════════════════════════ */
section('Monthly bounce — entry conditions');

/* December closes at 4.00 — the month-to-date reference. January then falls
   hard and turns on the 6th:
     Jan 4  c 3.85   MTD  -3.75%
     Jan 5  c 3.30   MTD -17.50%
     Jan 6  c 3.45   day +4.55%, MTD -13.75%   ← all conditions met
   Month high through the 6th is 4.10, month low 3.25.                     */
const dec = [bar('2020-12-30', 4.05, 4.10, 4.00, 4.02), bar('2020-12-31', 4.02, 4.05, 3.98, 4.00)];
const jan = [
  bar('2021-01-04', 4.00, 4.10, 3.80, 3.85),
  bar('2021-01-05', 3.83, 3.85, 3.25, 3.30),
  bar('2021-01-06', 3.32, 3.50, 3.28, 3.45),
  bar('2021-01-07', 3.50, 3.60, 3.40, 3.55),
];
const base = [...dec, ...jan];
const after = (...rows) => [...base, ...rows];
const sig = r => r.trades.length;

{
  const r = runBacktest(after(bar('2021-01-08', 3.55, 4.20, 3.50, 4.15)), monthlyBounce());
  eq('all conditions met produces one trade', sig(r), 1);
  const t = r.trades[0];
  eq('  entry is the next open', t.entryPrice, 3.50);
  eq('  target is the monthly high', t.target, 4.10);
  eq('  stop is the monthly low', t.stop, 3.25);
  ok('  exit at the monthly high', t.exitReason === 'target' && Math.abs(t.exitPrice - 4.10) < 1e-9);
  eq('  P&L is entry-to-target', r.finalEquity, 100_000 * 4.10 / 3.50, 1e-6);
}
{
  /* Same setup, but it loses the month's low instead. */
  const r = runBacktest(after(bar('2021-01-08', 3.55, 3.58, 3.10, 3.15)), monthlyBounce());
  eq('breaking the monthly low stops it out', sig(r), 1);
  ok('  at the low, not the close', r.trades[0].exitReason === 'stop'
     && Math.abs(r.trades[0].exitPrice - 3.25) < 1e-9);
  eq('  P&L is entry-to-stop', r.finalEquity, 100_000 * 3.25 / 3.50, 1e-6);
}
{
  /* Every bar is outside the +2%..+20% band and nothing else changes: the
     6th is +1.5%, the 7th +0.3%, the 8th +23.5%. The month is down enough
     throughout, so the day-gain band is the only thing refusing these. */
  const bars = [...dec, jan[0], jan[1],
    bar('2021-01-06', 3.32, 3.40, 3.28, 3.35),
    bar('2021-01-07', 3.35, 3.40, 3.30, 3.36),
    bar('2021-01-08', 3.36, 4.20, 3.35, 4.15)];
  eq('a day gain outside +2%..+20% never qualifies', sig(runBacktest(bars, monthlyBounce())), 0);
}
{
  /* January only dips to 3.90: MTD -2.5% on the turn, nowhere near -10%. */
  const shallow = [...dec,
    bar('2021-01-04', 4.00, 4.05, 3.90, 3.95),
    bar('2021-01-05', 3.94, 3.96, 3.78, 3.80),
    bar('2021-01-06', 3.82, 3.95, 3.80, 3.90),
    bar('2021-01-07', 3.90, 4.00, 3.88, 3.95),
    bar('2021-01-08', 3.95, 4.30, 3.90, 4.25)];
  eq('a month down less than 10% does not qualify', sig(runBacktest(shallow, monthlyBounce())), 0);
}
{
  const scale = (b, k) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k,
                             raw: { open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k } });
  const dear = after(bar('2021-01-08', 3.55, 4.20, 3.50, 4.15)).map(b => scale(b, 3));   // ~$10–12
  eq('a stock over $5 does not qualify', sig(runBacktest(dear, monthlyBounce())), 0);
  const cheap = after(bar('2021-01-08', 3.55, 4.20, 3.50, 4.15)).map(b => scale(b, 0.2)); // ~$0.70
  eq('a stock under $1 does not qualify', sig(runBacktest(cheap, monthlyBounce())), 0);
}
{
  /* The screen must read `raw`. These bars are adjusted to ~$3.45 but the
     stock actually changed hands at ~$0.35 — below $1, so it is out. A
     screen run on the adjusted series would take the trade. */
  const disguised = after(bar('2021-01-08', 3.55, 4.20, 3.50, 4.15))
    .map(b => ({ ...b, raw: { open: b.open / 10, high: b.high / 10, low: b.low / 10, close: b.close / 10 } }));
  eq('the price screen reads unadjusted prices', sig(runBacktest(disguised, monthlyBounce())), 0);
  const noRaw = after(bar('2021-01-08', 3.55, 4.20, 3.50, 4.15)).map(({ raw, ...b }) => b);
  eq('  and falls back to adjusted when there is no raw', sig(runBacktest(noRaw, monthlyBounce())), 1);
}
{
  const bars = after(bar('2021-01-08', 3.55, 4.20, 3.50, 4.15));
  eq('the universe screen can veto an entry',
     sig(runBacktest(bars, monthlyBounce({ universe: () => false }))), 0);
  eq('  and pass one through',
     sig(runBacktest(bars, monthlyBounce({ universe: () => true }))), 1);
}
{
  /* The two readings diverge here. Through yesterday's close the month was
     -11.25%; the bounce lifts it to -6.25%, so only the "before the bounce"
     reading qualifies. Kept off the -10% line on purpose: 3.60/4.00-1 is
     -9.999999999999998 in binary floating point, and a fixture sitting on
     a threshold tests the arithmetic of doubles, not the rule. */
  const edge = [...dec,
    bar('2021-01-04', 4.00, 4.10, 3.80, 3.85),
    bar('2021-01-05', 3.83, 3.85, 3.52, 3.55),   // MTD -11.25%
    bar('2021-01-06', 3.57, 3.80, 3.56, 3.75),   // +5.6% on the day, MTD -6.25%
    bar('2021-01-07', 3.75, 3.80, 3.70, 3.78),
    bar('2021-01-08', 3.78, 4.20, 3.75, 4.15)];
  eq('dropIncludesToday on: the bounce must still leave it down 10%',
     sig(runBacktest(edge, monthlyBounce({ dropIncludesToday: true }))), 0);
  eq('dropIncludesToday off: it was down 10% before the bounce',
     sig(runBacktest(edge, monthlyBounce({ dropIncludesToday: false }))), 1);
}
{
  /* Nothing to sell into: today IS the month's high, so the limit would sit
     at or below the entry. */
  const noUpside = [...dec,
    bar('2021-01-04', 4.00, 4.00, 3.40, 3.45),
    bar('2021-01-05', 3.45, 3.46, 3.10, 3.15),
    bar('2021-01-06', 3.16, 4.05, 3.15, 4.02),   // +27.6%, over the ceiling anyway
    bar('2021-01-07', 4.02, 4.10, 3.95, 4.05)];
  eq('a bar that is itself the monthly high yields no trade',
     sig(runBacktest(noUpside, monthlyBounce())), 0);
}

section('Funnel');
{
  const r = runBacktest(after(bar('2021-01-08', 3.55, 4.20, 3.50, 4.15)), monthlyBounce());
  const st = r.ctx.stats;
  ok('trade carries its levels', r.trades[0].target === 4.10 && r.trades[0].stop === 3.25);
  eq('funnel counts the signal', st.signals, 1);
  ok('funnel narrows monotonically',
     st.bars >= st.hadRef && st.hadRef >= st.inPrice && st.inPrice >= st.dayOk
     && st.dayOk >= st.monthOk && st.monthOk >= st.universeOk && st.universeOk >= st.signals);
  eq('unenforced universe is reported as such', monthlyBounce().params.universeEnforced, 0, 1);
  ok('  and enforced when supplied', monthlyBounce({ universe: () => true }).params.universeEnforced === true);
}

/* ══ Universe screen ════════════════════════════════════════════════════ */
section('Universe screen');
const UNI = parseUniverse(`symbol,date,type,float
ABCD,2019-01-01,CS,42000000
ABCD,2020-06-01,CS,1400000000
EFGH,2019-01-01,ETF,50000000
IJKL,2019-01-01,CS,
MNOP,2021-01-01,CS,10000000`);
{
  const s = makeScreen(UNI, 'ABCD');
  ok('a small-float common stock passes', s(T('2019-05-01')) === true);
  /* The same company after a raise that took it past a billion. Screening
     these 2019 bars on the 2020 number would have excluded them — using
     knowledge of a dilution that had not happened. */
  ok('the same name fails after its float grows', s(T('2020-09-01')) === false);
  ok('  and still passes before the row it grew on', s(T('2020-05-31')) === true);
}
{
  const s = makeScreen(UNI, 'ABCD');
  ok('a bar before any row is excluded', s(T('2018-06-01')) === false);
  const lenient = makeScreen(UNI, 'ABCD', { onMissing: 'include' });
  ok('  unless onMissing says include', lenient(T('2018-06-01')) === true);
}
ok('an ETF is not a common stock', makeScreen(UNI, 'EFGH')(T('2019-05-01')) === false);
ok('a missing float is excluded, not assumed small',
   makeScreen(UNI, 'IJKL')(T('2019-05-01')) === false);
ok('a symbol absent from the file is excluded',
   makeScreen(UNI, 'ZZZZ')(T('2019-05-01')) === false);
ok('the float bound is exclusive at 1bn',
   makeScreen(parseUniverse('symbol,date,type,float\nX,2019-01-01,CS,1000000000'), 'X')(T('2019-05-01')) === false);
{
  const s = makeScreen(UNI, 'ABCD');
  s(T('2019-05-01')); s(T('2020-09-01')); s(T('2018-06-01'));
  ok('the screen counts what it rejected and why',
     s.stats.passed === 1 && s.stats.tooBig === 1 && s.stats.missing === 1, JSON.stringify(s.stats));
}
{
  /* End to end: the same bars, with and without a screen that vetoes. */
  const bars = after(bar('2021-01-08', 3.55, 4.20, 3.50, 4.15));
  const veto = makeScreen(UNI, 'ABCD');            // no rows in Jan 2021 → but ABCD has 2020-06 row
  eq('a screened run still trades when the name qualifies',
     sig(runBacktest(bars, monthlyBounce({ universe: makeScreen(UNI, 'MNOP') }))), 1);
  eq('  and does not when its float is too big',
     sig(runBacktest(bars, monthlyBounce({ universe: veto }))), 0);
}

/* ══ Pooled statistics and portfolio ════════════════════════════════════ */
section('Pooled statistics');
{
  /* Two wins at +20%, three losses at -10%. Breakeven for a 2:1 payoff is
     1/3, the win rate is 2/5, so the edge is 6.67 points and expectancy is
     (0.4 + -0.3) / 5 = +2% a trade. */
  const t = r => ({ returnPct: r, bars: 5, exitReason: r > 0 ? 'target' : 'stop' });
  const p = poolTrades([t(0.20), t(-0.10), t(0.20), t(-0.10), t(-0.10)]);
  eq('win rate', p.winRate, 0.4);
  eq('average win', p.avgWin, 0.20, 1e-12);
  eq('average loss', p.avgLoss, -0.10, 1e-12);
  eq('payoff ratio', p.payoff, 2, 1e-12);
  eq('breakeven win rate', p.breakevenWinRate, 1 / 3, 1e-12);
  eq('edge over breakeven', p.edge, 0.4 - 1 / 3, 1e-12);
  eq('expectancy per trade', p.expectancy, 0.02, 1e-12);
  ok('exit reasons counted', p.byReason.target === 2 && p.byReason.stop === 3);
}
{
  /* The invariant that makes breakeven worth printing: a win rate above it
     is positive expectancy, and below it is negative, always. */
  const t = r => ({ returnPct: r, bars: 1 });
  for (const [wins, losses] of [[1, 9], [5, 5], [9, 1], [3, 7], [7, 3]]) {
    const trades = [...Array(wins).fill(t(0.15)), ...Array(losses).fill(t(-0.08))];
    const p = poolTrades(trades);
    ok(`edge and expectancy agree in sign (${wins}/${wins + losses})`,
       Math.sign(p.edge) === Math.sign(p.expectancy), `edge ${p.edge}, exp ${p.expectancy}`);
  }
}
ok('an empty trade list is not an error', poolTrades([]).trades === 0);

section('Portfolio');
{
  const tr = (entry, exit, ret) => ({ entryTime: entry, exitTime: exit, returnPct: ret, bars: 1 });
  {
    const s = simulatePortfolio([tr(0, 10, 0.2)], { maxPositions: 1 });
    eq('one trade, one slot', s.final, 120_000, 1e-6);
  }
  {
    /* Sequential trades compound: 100k → 120k → 144k. */
    const s = simulatePortfolio([tr(0, 10, 0.2), tr(20, 30, 0.2)], { maxPositions: 1 });
    eq('sequential trades compound', s.final, 144_000, 1e-6);
    eq('  both taken', s.taken, 2);
  }
  {
    const s = simulatePortfolio([tr(0, 10, 0.2), tr(5, 15, 0.2)], { maxPositions: 1 });
    eq('an overlapping signal is skipped when full', s.skipped, 1);
    eq('  only the first is taken', s.taken, 1);
    eq('  and the account reflects one trade', s.final, 120_000, 1e-6);
  }
  {
    /* Two slots, half the book each, both +20% → +20% overall. */
    const s = simulatePortfolio([tr(0, 10, 0.2), tr(5, 15, 0.2)], { maxPositions: 2 });
    eq('two slots take both', s.taken, 2);
    eq('  each on half the book', s.final, 120_000, 1e-6);
  }
  {
    /* Capital freed by an exit is usable by an entry on the same day. Sort
       the other way and this second trade is skipped for want of a slot. */
    const s = simulatePortfolio([tr(0, 10, 0.2), tr(10, 20, 0.2)], { maxPositions: 1 });
    eq('an exit settles before an entry at the same stamp', s.taken, 2);
    eq('  so the capital recycles', s.final, 144_000, 1e-6);
  }
  {
    /* A bracket is live from the moment of entry, so a trade can open and
       close inside one bar. Its exit must still sort after its own entry —
       otherwise the exit finds nothing open, the entry takes a slot that is
       never released, and the run quietly stops trading. */
    const s = simulatePortfolio([tr(0, 0, -0.1), tr(5, 15, 0.2)], { maxPositions: 1 });
    eq('a same-day round trip does not leak its slot', s.taken, 2);
    eq('  and both P&Ls land', s.final, 100_000 * 0.9 * 1.2, 1e-6);
  }
  {
    /* Three same-day signals, one slot. Only the first is taken: daily bars
       carry no intraday sequence, so there is nothing to say the slot was
       free again in time for the second. Assuming it was would be inventing
       fills out of a timestamp that has no hours in it. The slot is released
       by the end of the day — the case above shows the next day using it. */
    const s = simulatePortfolio([tr(0, 0, 0.1), tr(0, 0, 0.1), tr(0, 0, 0.1)], { maxPositions: 1 });
    eq('same-day signals do not recycle one slot', s.taken, 1);
    eq('  the rest are skipped', s.skipped, 2);
    eq('  and only the one taken pays', s.final, 110_000, 1e-6);
  }
  {
    const s = simulatePortfolio([tr(0, 10, -0.5)], { maxPositions: 1 });
    eq('losses reduce the account', s.final, 50_000, 1e-6);
    ok('  and show as drawdown', s.maxDrawdown > 0.49);
  }
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
