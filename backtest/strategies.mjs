/* ═══════════════════════════════════════════════════════════════════════
   STRATEGIES — rules, expressed against the archived TA engine
   ───────────────────────────────────────────────────────────────────────
   A strategy is two functions:

     prepare(bars) → ctx      once, up front. Compute indicator arrays here.
     decide(cursor, ctx, pos, equity) → 1 | 0 | -1 | null

   `cursor.i` is the current bar, `cursor.bar` its OHLCV, `cursor.prior(k)`
   the bar k back. The cursor throws if you reach past `i`, so the common
   lookahead mistake fails loudly instead of paying well.

   Return 1 to be long, -1 short, 0 flat, or null to leave the position
   alone. That last one is the difference between "my exit rule has not
   fired" and "go flat", and most published rules mean the former.

   Whatever you return on bar i is filled at bar i+1's open — you are
   deciding with a closing price you could only have known at the close.

   Indicators come from archive/lightweight-engine/ta.js: 41 of them, Pine
   v5 warm-up semantics, Wilder's RMA where Wilder intended it, and 228
   tests behind them. Every array it returns is aligned with `bars` and
   holds `null` until the indicator has warmed up — check for null before
   comparing, or you will be comparing against nothing.
   ═══════════════════════════════════════════════════════════════════════ */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LONG, FLAT, SHORT } from './engine.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TA = require(path.join(ROOT, 'archive', 'lightweight-engine', 'ta.js'));

const closes = bars => TA.col(bars, 'close');

/* ── Reference strategies ─────────────────────────────────────────────────
   Here to exercise the engine and to show the shape. None of them is a
   recommendation; the first two in particular are the most over-fitted
   ideas in retail trading and are included because everybody asks. */

export const smaCross = (fast = 50, slow = 200) => ({
  name: `SMA ${fast}/${slow}`,
  params: { fast, slow },
  prepare: bars => ({ f: TA.sma(closes(bars), fast), s: TA.sma(closes(bars), slow) }),
  decide: (c, ctx) => {
    const f = ctx.f[c.i], s = ctx.s[c.i];
    if (f == null || s == null) return FLAT;
    return f > s ? LONG : FLAT;
  },
});

export const emaCrossLongShort = (fast = 20, slow = 50) => ({
  name: `EMA ${fast}/${slow} L/S`,
  params: { fast, slow },
  prepare: bars => ({ f: TA.ema(closes(bars), fast), s: TA.ema(closes(bars), slow) }),
  decide: (c, ctx) => {
    const f = ctx.f[c.i], s = ctx.s[c.i];
    if (f == null || s == null) return FLAT;
    return f > s ? LONG : SHORT;
  },
});

/* Buy oversold, sell back at the midline. Note the `null`: without an exit
   signal the position is held, which is what "exit at 50" actually means. */
export const rsiReversion = (n = 14, lo = 30, exit = 50) => ({
  name: `RSI(${n}) < ${lo} → ${exit}`,
  params: { n, lo, exit },
  prepare: bars => ({ r: TA.rsi(closes(bars), n) }),
  decide: (c, ctx, pos) => {
    const r = ctx.r[c.i];
    if (r == null) return FLAT;
    if (pos === FLAT && r < lo) return LONG;
    if (pos === LONG && r > exit) return FLAT;
    return null;
  },
});

export const macdCross = (fast = 12, slow = 26, sig = 9) => ({
  name: `MACD ${fast}/${slow}/${sig}`,
  params: { fast, slow, sig },
  prepare: bars => ({ m: TA.macd(closes(bars), fast, slow, sig) }),
  decide: (c, ctx) => {
    const h = ctx.m.hist[c.i];
    return h == null ? FLAT : (h > 0 ? LONG : FLAT);
  },
});

/* Donchian breakout — the Turtle rule. Enter on a new n-bar high, leave on
   a new exit-bar low. */
export const donchianBreakout = (entry = 55, exit = 20) => ({
  name: `Donchian ${entry}/${exit}`,
  params: { entry, exit },
  prepare: bars => ({ hi: TA.donchian(bars, entry).upper, lo: TA.donchian(bars, exit).lower }),
  decide: (c, ctx, pos) => {
    const prior = c.prior(1);
    if (!prior) return FLAT;
    /* Compare against the channel as of the PREVIOUS bar: today's high is
       inside today's own channel by construction, so using ctx.hi[c.i]
       would mean the breakout could never be detected. */
    const hi = ctx.hi[c.i - 1], lo = ctx.lo[c.i - 1];
    if (hi == null || lo == null) return FLAT;
    if (pos === FLAT && c.bar.close > hi) return LONG;
    if (pos === LONG && c.bar.close < lo) return FLAT;
    return null;
  },
});

export const supertrendFollow = (atrPeriod = 10, mult = 3) => ({
  name: `Supertrend ${atrPeriod}/${mult}`,
  params: { atrPeriod, mult },
  prepare: bars => ({ st: TA.supertrend(bars, atrPeriod, mult) }),
  decide: (c, ctx) => {
    const s = ctx.st[c.i];
    return (s == null || s.value == null) ? FLAT : (s.trend === 1 ? LONG : SHORT);
  },
});

export const bollingerReversion = (n = 20, mult = 2) => ({
  name: `Bollinger ${n}/${mult} reversion`,
  params: { n, mult },
  prepare: bars => ({ b: TA.bollinger(bars, n, mult) }),
  decide: (c, ctx, pos) => {
    const lo = ctx.b.lower[c.i], mid = ctx.b.mid[c.i];
    if (lo == null || mid == null) return FLAT;
    if (pos === FLAT && c.bar.close < lo) return LONG;
    if (pos === LONG && c.bar.close > mid) return FLAT;
    return null;
  },
});

export const REFERENCE = {
  'sma-cross':   smaCross,
  'ema-ls':      emaCrossLongShort,
  'rsi':         rsiReversion,
  'macd':        macdCross,
  'donchian':    donchianBreakout,
  'supertrend':  supertrendFollow,
  'bollinger':   bollingerReversion,
};

/* ══ Your rules ═════════════════════════════════════════════════════════
   Replace `myRules` with your own entry and exit conditions and run:

     node backtest/run.mjs --strategy mine --symbol AAPL

   A worked template, with the three things that are easy to get wrong
   called out:

     export const myRules = {
       name: 'Pullback in an uptrend',
       prepare: bars => ({
         trend: TA.ema(TA.col(bars, 'close'), 200),
         r:     TA.rsi(TA.col(bars, 'close'), 2),
         stop:  TA.atr(bars, 14),
       }),
       decide: (c, ctx, pos, equity) => {
         const trend = ctx.trend[c.i], r = ctx.r[c.i];
         if (trend == null || r == null) return FLAT;   // (1) warm-up is null
         if (pos === FLAT && c.bar.close > trend && r < 10) return LONG;
         if (pos === LONG && r > 70) return FLAT;
         return null;                                    // (2) null holds
       },
     };

   (1) Every indicator is null until it has warmed up. `null < 10` is true
       in JavaScript, so an unguarded comparison buys the warm-up period.
   (2) Returning FLAT on every bar your entry does not fire will exit the
       position the bar after it opens. Return null to hold.
   (3) You get `pos` and `equity` for free — position-dependent rules and
       equity-dependent sizing do not need any state of your own.
   ═══════════════════════════════════════════════════════════════════════ */

export const myRules = null;
