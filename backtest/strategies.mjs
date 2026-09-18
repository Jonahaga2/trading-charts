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

/* ══ Monthly bounce ═════════════════════════════════════════════════════
   Buy a beaten-down low-priced name on the day it turns, take profit at the
   high the month has already made, cut it if it loses the month's low.

     entry   month-to-date return <= -10%
             today's return between +2% and +20%
             price between $1 and $5          (unadjusted — see below)
             common stock, float under 1bn    (needs reference data)
     exit    limit at the monthly high, stop at the monthly low

   Both exits are resting orders, so they fill intrabar; the engine takes
   the stop first where one bar touches both, because OHLC cannot say which
   came first.

   The levels are fixed at entry. "Sell it at the monthly high" is a limit
   order, and an order you placed on Tuesday does not move because Thursday
   printed a higher high — if you meant a target that ratchets up with the
   month, that is a different rule and a different result.

   Month-to-date is measured from the previous month's closing price, the
   standard reference. `dropIncludesToday` decides whether the -10% is
   tested through today's close or through yesterday's: with it on (the
   default) the stock must still be down 10% after the bounce you are
   buying, which is the stricter and, I think, the intended reading. It
   changes the trade count materially, so it is a flag rather than a
   decision made quietly on your behalf.

   The price screen runs on `bar.raw` — unadjusted. Run it on adjusted
   prices and you select the companies that later reverse-split, which is
   to say the ones that were failing. If the bars carry no raw prices the
   screen falls back to adjusted and says so in the funnel.                */

const monthIndex = t => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

export const monthlyBounce = ({
  monthDropPct = 10,
  dayGainMin = 2,
  dayGainMax = 20,
  priceMin = 1,
  priceMax = 5,
  dropIncludesToday = true,
  universe = null,            // (timeSec) => boolean — common stock + float screen
} = {}) => ({
  name: `Monthly bounce ${monthDropPct}% / +${dayGainMin}–${dayGainMax}% / $${priceMin}–${priceMax}`,
  params: { monthDropPct, dayGainMin, dayGainMax, priceMin, priceMax, dropIncludesToday,
            universeEnforced: typeof universe === 'function' },

  prepare(bars) {
    const n = bars.length;
    const prevMonthClose = new Array(n).fill(null);
    const mtdHigh = new Array(n).fill(null);
    const mtdLow = new Array(n).fill(null);
    let key = null, ref = null, hi = -Infinity, lo = Infinity;

    for (let i = 0; i < n; i++) {
      const k = monthIndex(bars[i].time);
      if (k !== key) { key = k; ref = i > 0 ? bars[i - 1].close : null; hi = -Infinity; lo = Infinity; }
      hi = Math.max(hi, bars[i].high);
      lo = Math.min(lo, bars[i].low);
      prevMonthClose[i] = ref; mtdHigh[i] = hi; mtdLow[i] = lo;
    }
    /* A funnel, so "no trades" can be read as a fact about the data rather
       than a suspicion about the code. */
    const stats = { bars: n, hadRef: 0, inPrice: 0, dayOk: 0, monthOk: 0, universeOk: 0,
                    targetAbove: 0, signals: 0, usedAdjustedForPrice: 0 };
    return { prevMonthClose, mtdHigh, mtdLow, stats, screen: universe || null };
  },

  decide(c, ctx, pos) {
    /* Holding: the exits are resting orders, not signals. */
    if (pos !== FLAT) return null;

    const i = c.i, bar = c.bar, prior = c.prior(1);
    const ref = ctx.prevMonthClose[i];
    const S = ctx.stats;
    if (!prior || ref == null || ref === 0) return FLAT;
    S.hadRef++;

    const level = bar.raw ? bar.raw.close : (S.usedAdjustedForPrice++, bar.close);
    if (level < priceMin || level > priceMax) return FLAT;
    S.inPrice++;

    const dayGain = (bar.close / prior.close - 1) * 100;
    if (dayGain < dayGainMin || dayGain > dayGainMax) return FLAT;
    S.dayOk++;

    const mtd = ((dropIncludesToday ? bar.close : prior.close) / ref - 1) * 100;
    if (mtd > -monthDropPct) return FLAT;
    S.monthOk++;

    if (universe && !universe(bar.time)) return FLAT;
    S.universeOk++;

    const target = ctx.mtdHigh[i], stop = ctx.mtdLow[i];
    /* If today already made the month's high there is nothing to sell into,
       and if the month's low is above us the stop is already breached. */
    if (!(target > bar.close) || !(stop < bar.close)) return FLAT;
    S.targetAbove++; S.signals++;

    return { position: LONG, target, stop };
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
  'bounce':      monthlyBounce,
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

/* Your criteria, as given. `monthlyBounce` above is the implementation;
   its options are there to change without touching the logic. */
export const myRules = monthlyBounce();
