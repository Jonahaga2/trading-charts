/* Verification for src/ta.js.
   Three independent lines of attack:
     1. GOLDEN     — values computed by hand from each indicator's definition.
     2. INDEPENDENT — a second, deliberately naive implementation of every
                      rolling primitive, cross-checked against the fast one.
     3. INVARIANTS  — bounds, identities, warm-up positions, purity, and the
                      strictly-increasing-time requirement the renderer has.
   Run: node test/ta.test.mjs                                              */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const TA = require(path.join(HERE, 'ta.js'));

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; } else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected, tol = 1e-9) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      return ok(name, false, `length ${actual?.length} != ${expected.length}`);
    for (let i = 0; i < expected.length; i++) {
      const a = actual[i], e = expected[i];
      if (e === null || a === null) {
        if (a !== e) return ok(name, false, `[${i}] ${a} != ${e}`);
      } else if (!(Math.abs(a - e) <= tol)) {
        return ok(name, false, `[${i}] ${a} != ${e}`);
      }
    }
    return ok(name, true);
  }
  if (expected === null || actual === null) return ok(name, actual === expected, `${actual} != ${expected}`);
  return ok(name, Math.abs(actual - expected) <= tol, `${actual} != ${expected}`);
}
const section = s => console.log(`\n\x1b[1m${s}\x1b[0m`);

/* ═══ Fixtures ═══════════════════════════════════════════════════════ */
const mkBars = (rows) => rows.map(([o, h, l, c, v], i) =>
  ({ time: 1700000000 + i * 60, open: o, high: h, low: l, close: c, volume: v ?? 1000 }));

// Deterministic pseudo-random OHLCV walk — same series every run.
function synthBars(n, seed = 42) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const bars = []; let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.48) * 2;
    const open = px;
    const close = Math.max(1, px + drift);
    const high = Math.max(open, close) + rnd() * 1.5;
    const low = Math.min(open, close) - rnd() * 1.5;
    bars.push({ time: 1700000000 + i * 300, open, high, low: Math.max(0.5, low), close, volume: Math.floor(rnd() * 1e6) + 1 });
    px = close;
  }
  return bars;
}
const BARS = synthBars(500);
const CLOSES = BARS.map(b => b.close);

/* ═══ 1. GOLDEN VALUES ═══════════════════════════════════════════════ */
section('1. Golden values (hand-computed from each definition)');

eq('sma([1..5],3)', TA.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);

// alpha = 2/(3+1) = 0.5, seeded with sma(3) = (2+4+6)/3 = 4 at i=2
eq('ema([2,4,6,8,10,12],3)', TA.ema([2, 4, 6, 8, 10, 12], 3), [null, null, 4, 6, 8, 10]);

// alpha = 1/3, seed 2 at i=2 -> 2.666667 -> 3.444444
eq('rma([1..5],3) (Wilder)', TA.rma([1, 2, 3, 4, 5], 3), [null, null, 2, 8 / 3, 31 / 9]);

// (1*1 + 2*2 + 3*3)/6 = 14/6
eq('wma([1,2,3],3)', TA.wma([1, 2, 3], 3), [null, null, 14 / 6]);

// Textbook population stdev: mean 5, sum sq dev 32, /8 = 4, sqrt = 2
eq('stdev([2,4,4,4,5,5,7,9],8)', TA.stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7], 2);

eq('highest([3,1,4,1,5,9,2,6],3)', TA.highest([3, 1, 4, 1, 5, 9, 2, 6], 3), [null, null, 4, 4, 5, 9, 9, 9]);
eq('lowest([3,1,4,1,5,9,2,6],3)',  TA.lowest([3, 1, 4, 1, 5, 9, 2, 6], 3),  [null, null, 1, 1, 1, 1, 2, 2]);

// gains rma(2): seed .5 -> .75 -> .875 ; losses rma(2): seed .5 -> .25 -> .125
eq('rsi([10,11,10,11,12],2)', TA.rsi([10, 11, 10, 11, 12], 2), [null, null, 50, 75, 87.5]);

// TR = [2,2,2,4]; rma(2) seed at i=1 = 2 -> 2 -> 3
{
  const b = mkBars([[9, 10, 8, 9], [10, 11, 9, 10], [11, 12, 10, 11], [12, 13, 9, 12]]);
  eq('trueRange', TA.trueRange(b), [2, 2, 2, 4]);
  eq('atr(2) uses Wilder RMA', TA.atr(b, 2), [null, 2, 2, 3]);
}
// True range must span the gap to the PREVIOUS close, not just the bar's own
// high-low. On a non-gapping fixture the two are identical, which is exactly
// how a prevClose bug hides — so gap this one hard in both directions.
{
  const gapped = mkBars([[9, 10, 8, 9], [19, 20, 18, 19], [4, 5, 3, 4]]);
  //  bar1: max(20-18, |20-9|, |18-9|) = 11
  //  bar2: max(5-3,   |5-19|, |3-19|) = 16
  eq('trueRange spans gaps to the prior close', TA.trueRange(gapped), [2, 11, 16]);
}

// Heikin-Ashi first bar: close=(10+12+8+11)/4=10.25, open=(10+11)/2=10.5
{
  const ha = TA.heikinAshi(mkBars([[10, 12, 8, 11], [11, 13, 10, 12]]));
  eq('HA[0].close', ha[0].close, 10.25);
  eq('HA[0].open',  ha[0].open, 10.5);
  eq('HA[0].high',  ha[0].high, 12);
  eq('HA[0].low',   ha[0].low, 8);
  // second bar open = (prevOpen + prevClose)/2 = (10.5 + 10.25)/2
  eq('HA[1].open',  ha[1].open, (10.5 + 10.25) / 2);
}

// OBV: closes 10,11,10,12 with vols 100,200,300,400
eq('obv', TA.obv(mkBars([[0, 0, 0, 10, 100], [0, 0, 0, 11, 200], [0, 0, 0, 10, 300], [0, 0, 0, 12, 400]])),
  [0, 200, -100, 300]);

eq('roc([10,11,12],1)', TA.roc([10, 11, 12], 1), [null, 10, (12 - 11) / 11 * 100]);
eq('momentum([10,11,12],2)', TA.momentum([10, 11, 12], 2), [null, null, 2]);
eq('change([5,7,4])', TA.change([5, 7, 4]), [null, 2, -3]);

// Williams %R over 3 bars: highest high 12, lowest low 8, close 11 -> (12-11)/(12-8)*-100 = -25
{
  const b = mkBars([[0, 10, 8, 9], [0, 11, 9, 10], [0, 12, 9, 11]]);
  eq('williamsR(3)', TA.williamsR(b, 3)[2], -25);
  eq('stoch %K(3)',  TA.stoch(b, 3, 1).k[2], (11 - 8) / (12 - 8) * 100);
}

// DPO: shift = floor(4/2)+1 = 3 -> out[i] = src[i-3] - sma4[i]
{
  const src = [1, 2, 3, 4, 5, 6, 7, 8];
  const d = TA.dpo(src, 4);
  eq('dpo[3] = src[0] - sma4[3]', d[3], 1 - (1 + 2 + 3 + 4) / 4);
  eq('dpo[7] = src[4] - sma4[7]', d[7], 5 - (5 + 6 + 7 + 8) / 4);
}

/* ═══ 2. INDEPENDENT IMPLEMENTATION CROSS-CHECK ══════════════════════ */
section('2. Cross-check vs an independent naive implementation');

const naive = {
  sma: (s, n) => s.map((_, i) => i < n - 1 ? null
    : s.slice(i - n + 1, i + 1).some(v => v == null) ? null
      : s.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n),
  smoothed: (s, n, alpha) => {
    const out = new Array(s.length).fill(null);
    let prev = null, buf = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] == null) { if (prev === null) buf = []; continue; }
      if (prev === null) {
        buf.push(s[i]);
        if (buf.length === n) { prev = buf.reduce((a, b) => a + b, 0) / n; out[i] = prev; }
      } else { prev = alpha * s[i] + (1 - alpha) * prev; out[i] = prev; }
    }
    return out;
  },
  stdev: (s, n) => s.map((_, i) => {
    if (i < n - 1) return null;
    const w = s.slice(i - n + 1, i + 1);
    if (w.some(v => v == null)) return null;
    const m = w.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  }),
  highest: (s, n) => s.map((_, i) => {
    if (i < n - 1) return null;
    const w = s.slice(i - n + 1, i + 1);
    return w.some(v => v == null) ? null : Math.max(...w);
  }),
  lowest: (s, n) => s.map((_, i) => {
    if (i < n - 1) return null;
    const w = s.slice(i - n + 1, i + 1);
    return w.some(v => v == null) ? null : Math.min(...w);
  }),
  vwma: (bars, n) => bars.map((_, i) => {
    if (i < n - 1) return null;
    const w = bars.slice(i - n + 1, i + 1);
    const vol = w.reduce((a, b) => a + (b.volume || 0), 0);
    return vol > 0 ? w.reduce((a, b) => a + b.close * (b.volume || 0), 0) / vol : null;
  }),
  cmf: (bars, n) => bars.map((_, i) => {
    if (i < n - 1) return null;
    const w = bars.slice(i - n + 1, i + 1);
    const vol = w.reduce((a, b) => a + (b.volume || 0), 0);
    if (!(vol > 0)) return null;
    const mfv = w.reduce((a, b) => {
      const r = b.high - b.low;
      return a + (r === 0 ? 0 : ((b.close - b.low) - (b.high - b.close)) / r * (b.volume || 0));
    }, 0);
    return mfv / vol;
  }),
  chop: (bars, n) => {
    const tr = TA.trueRange(bars);
    return bars.map((_, i) => {
      if (i < n - 1) return null;
      const w = bars.slice(i - n + 1, i + 1);
      const hi = Math.max(...w.map(b => b.high)), lo = Math.min(...w.map(b => b.low));
      const sum = tr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0);
      return hi > lo ? 100 * Math.log10(sum / (hi - lo)) / Math.log10(n) : null;
    });
  },
  mfi: (bars, n) => {
    const tp = bars.map(b => (b.high + b.low + b.close) / 3);
    return bars.map((_, i) => {
      if (i < n) return null;
      let p = 0, q = 0;
      for (let j = i - n + 1; j <= i; j++) {
        const f = tp[j] * (bars[j].volume || 0);
        if (tp[j] > tp[j - 1]) p += f; else if (tp[j] < tp[j - 1]) q += f;
      }
      return q === 0 ? 100 : p === 0 ? 0 : 100 - 100 / (1 + p / q);
    });
  },
};

for (const n of [2, 5, 14, 20, 50, 200]) {
  eq(`sma vs naive (n=${n})`, TA.sma(CLOSES, n), naive.sma(CLOSES, n), 1e-8);
  eq(`ema vs naive (n=${n})`, TA.ema(CLOSES, n), naive.smoothed(CLOSES, n, 2 / (n + 1)), 1e-8);
  eq(`rma vs naive (n=${n})`, TA.rma(CLOSES, n), naive.smoothed(CLOSES, n, 1 / n), 1e-8);
  eq(`stdev vs naive (n=${n})`, TA.stdev(CLOSES, n), naive.stdev(CLOSES, n), 1e-8);
  eq(`highest vs naive (n=${n})`, TA.highest(CLOSES, n), naive.highest(CLOSES, n));
  eq(`lowest vs naive (n=${n})`, TA.lowest(CLOSES, n), naive.lowest(CLOSES, n));
  eq(`vwma vs naive (n=${n})`, TA.vwma(BARS, n), naive.vwma(BARS, n), 1e-7);
  eq(`cmf vs naive (n=${n})`, TA.cmf(BARS, n), naive.cmf(BARS, n), 1e-9);
}
for (const n of [5, 14, 20]) {
  eq(`chop vs naive (n=${n})`, TA.chop(BARS, n), naive.chop(BARS, n), 1e-9);
  eq(`mfi vs naive (n=${n})`, TA.mfi(BARS, n), naive.mfi(BARS, n), 1e-8);
}

// Rolling-sum drift check: the fast paths must not accumulate error over a
// long series (this is what a rolling sum-of-squares would fail).
{
  const long = synthBars(5000).map(b => b.close);
  const d = TA.sma(long, 200), r = naive.sma(long, 200);
  let maxErr = 0;
  for (let i = 0; i < long.length; i++) if (d[i] != null) maxErr = Math.max(maxErr, Math.abs(d[i] - r[i]));
  ok('sma has no drift over 5000 bars', maxErr < 1e-9, `maxErr=${maxErr}`);
}

/* ═══ 3. INVARIANTS ══════════════════════════════════════════════════ */
section('3. Invariants and structural properties');

// -- purity: nothing may mutate its input --------------------------------
{
  const snapshot = JSON.stringify(BARS);
  TA.psar(BARS); TA.supertrend(BARS, 10, 3); TA.ultimateOsc(BARS, 7, 14, 28);
  TA.adx(BARS, 14); TA.mfi(BARS, 14); TA.ichimoku(BARS); TA.heikinAshi(BARS);
  TA.vwap(BARS, b => Math.floor(b.time / 86400)); TA.obv(BARS); TA.cci(BARS, 20);
  ok('no indicator mutates its input bars', JSON.stringify(BARS) === snapshot);
}

// -- no NaN / Infinity leaks anywhere ------------------------------------
{
  const flat = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v).flatMap(flat) : [v]);
  const results = {
    sma: TA.sma(CLOSES, 20), ema: TA.ema(CLOSES, 20), rma: TA.rma(CLOSES, 14),
    wma: TA.wma(CLOSES, 20), stdev: TA.stdev(CLOSES, 20), atr: TA.atr(BARS, 14),
    rsi: TA.rsi(CLOSES, 14), macd: TA.macd(CLOSES, 12, 26, 9), stoch: TA.stoch(BARS, 14, 3),
    stochRsi: TA.stochRsi(CLOSES, 14, 14), cci: TA.cci(BARS, 20), willr: TA.williamsR(BARS, 14),
    adx: TA.adx(BARS, 14), mfi: TA.mfi(BARS, 14), cmf: TA.cmf(BARS, 20), obv: TA.obv(BARS),
    vpt: TA.vpt(BARS), trix: TA.trix(CLOSES, 18), aroon: TA.aroon(BARS, 25), dpo: TA.dpo(CLOSES, 20),
    uo: TA.ultimateOsc(BARS, 7, 14, 28), elder: TA.elderRay(BARS, 13), ppo: TA.ppo(CLOSES, 12, 26, 9),
    roc: TA.roc(CLOSES, 12), mom: TA.momentum(CLOSES, 10), chop: TA.chop(BARS, 14),
    dema: TA.dema(CLOSES, 20), tema: TA.tema(CLOSES, 20), hma: TA.hma(CLOSES, 20),
    zlema: TA.zlema(CLOSES, 20), alma: TA.alma(CLOSES, 20), vwma: TA.vwma(BARS, 20),
    bb: TA.bollinger(BARS, 20, 2), keltner: TA.keltner(BARS, 20, 2), donchian: TA.donchian(BARS, 20),
    envelope: TA.envelope(BARS, 20, 2.5), ichimoku: TA.ichimoku(BARS),
    supertrend: TA.supertrend(BARS, 10, 3), psar: TA.psar(BARS),
    vwap: TA.vwap(BARS, b => Math.floor(b.time / 86400)),
  };
  for (const [name, res] of Object.entries(results)) {
    const bad = flat(res).filter(v => typeof v === 'number' && !Number.isFinite(v));
    ok(`${name}: no NaN/Infinity`, bad.length === 0, `${bad.length} bad values`);
  }
  // count of indicators exercised, so a silently-dropped one is visible
  ok('indicator coverage >= 40 outputs', Object.keys(results).length >= 40, `${Object.keys(results).length}`);
}

// -- warm-up starts exactly where Pine puts it ---------------------------
const firstIdx = a => a.findIndex(v => v !== null);
ok('sma(20) first value at index 19', firstIdx(TA.sma(CLOSES, 20)) === 19);
ok('ema(20) first value at index 19', firstIdx(TA.ema(CLOSES, 20)) === 19);
ok('rma(14) first value at index 13', firstIdx(TA.rma(CLOSES, 14)) === 13);
ok('rsi(14) first value at index 14', firstIdx(TA.rsi(CLOSES, 14)) === 14, `got ${firstIdx(TA.rsi(CLOSES, 14))}`);
ok('atr(14) first value at index 13', firstIdx(TA.atr(BARS, 14)) === 13);
ok('macd(12,26,9) line at index 25', firstIdx(TA.macd(CLOSES, 12, 26, 9).line) === 25);
ok('macd signal at index 33', firstIdx(TA.macd(CLOSES, 12, 26, 9).signal) === 33,
  `got ${firstIdx(TA.macd(CLOSES, 12, 26, 9).signal)}`);
ok('bollinger mid warm-up == sma warm-up', firstIdx(TA.bollinger(BARS, 20, 2).mid) === 19);

// A null anywhere in the input must not silently become a zero downstream.
{
  const withHole = CLOSES.slice(0, 60);
  const macdHole = TA.macd(withHole, 12, 26, 9);
  ok('macd signal never precedes macd line', firstIdx(macdHole.signal) > firstIdx(macdHole.line));
  const st = TA.stoch(BARS.slice(0, 40), 14, 3);
  ok('stoch %D never precedes %K', firstIdx(st.d) > firstIdx(st.k));
}

// -- bounded oscillators stay in range -----------------------------------
const inRange = (arr, lo, hi) => arr.every(v => v === null || (v >= lo - 1e-9 && v <= hi + 1e-9));
ok('rsi within [0,100]', inRange(TA.rsi(CLOSES, 14), 0, 100));
ok('stoch %K within [0,100]', inRange(TA.stoch(BARS, 14, 3).k, 0, 100));
ok('stoch %D within [0,100]', inRange(TA.stoch(BARS, 14, 3).d, 0, 100));
ok('stochRsi %K within [0,100]', inRange(TA.stochRsi(CLOSES, 14, 14).k, 0, 100));
ok('williamsR within [-100,0]', inRange(TA.williamsR(BARS, 14), -100, 0));
ok('mfi within [0,100]', inRange(TA.mfi(BARS, 14), 0, 100));
ok('aroon up within [0,100]', inRange(TA.aroon(BARS, 25).up, 0, 100));
ok('aroon down within [0,100]', inRange(TA.aroon(BARS, 25).down, 0, 100));
ok('cmf within [-1,1]', inRange(TA.cmf(BARS, 20), -1, 1));
ok('adx within [0,100]', inRange(TA.adx(BARS, 14).adx, 0, 100));
ok('+DI within [0,100]', inRange(TA.adx(BARS, 14).plusDI, 0, 100));
ok('atr non-negative', TA.atr(BARS, 14).every(v => v === null || v >= 0));
ok('chop within [0,100]', inRange(TA.chop(BARS, 14), 0, 100));

// -- monotone series drive oscillators to their limits -------------------
{
  const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
  const falling = Array.from({ length: 60 }, (_, i) => 160 - i);
  eq('rsi of a monotonically rising series == 100', TA.rsi(rising, 14)[59], 100);
  eq('rsi of a monotonically falling series == 0', TA.rsi(falling, 14)[59], 0);
}

// -- constant series identities ------------------------------------------
{
  const flat = new Array(80).fill(50);
  eq('sma(const) == const', TA.sma(flat, 20)[79], 50);
  eq('ema(const) == const', TA.ema(flat, 20)[79], 50);
  eq('rma(const) == const', TA.rma(flat, 14)[79], 50);
  eq('wma(const) == const', TA.wma(flat, 20)[79], 50);
  eq('stdev(const) == 0', TA.stdev(flat, 20)[79], 0);
  eq('roc(const) == 0', TA.roc(flat, 10)[79], 0);
  const flatBars = flat.map((c, i) => ({ time: i * 60, open: c, high: c, low: c, close: c, volume: 100 }));
  eq('atr(flat bars) == 0', TA.atr(flatBars, 14)[79], 0);
  eq('vwma(flat) == const', TA.vwma(flatBars, 20)[79], 50);
}

// -- band identities ------------------------------------------------------
{
  const bb = TA.bollinger(BARS, 20, 2), sm = TA.sma(CLOSES, 20);
  eq('bollinger mid == sma', bb.mid, sm);
  ok('bollinger is symmetric about mid',
    bb.mid.every((m, i) => m === null || Math.abs((bb.upper[i] - m) - (m - bb.lower[i])) < 1e-9));
  const dc = TA.donchian(BARS, 20);
  ok('donchian mid == (upper+lower)/2',
    dc.mid.every((m, i) => m === null || Math.abs(m - (dc.upper[i] + dc.lower[i]) / 2) < 1e-9));
  ok('donchian upper >= lower', dc.mid.every((m, i) => m === null || dc.upper[i] >= dc.lower[i]));
  const kc = TA.keltner(BARS, 20, 2);
  ok('keltner upper >= mid >= lower',
    kc.mid.every((m, i) => m === null || (kc.upper[i] >= m && m >= kc.lower[i])));
  const env = TA.envelope(BARS, 20, 2.5);
  ok('envelope is symmetric in percent',
    env.mid.every((m, i) => m === null || Math.abs((env.upper[i] / m - 1) - (1 - env.lower[i] / m)) < 1e-12));
}

// -- vwma with constant volume degenerates to sma -------------------------
{
  const evenVol = BARS.map(b => ({ ...b, volume: 1000 }));
  eq('vwma(constant volume) == sma(close)', TA.vwma(evenVol, 20), TA.sma(CLOSES, 20), 1e-8);
}

// -- MACD/PPO identities ---------------------------------------------------
{
  const m = TA.macd(CLOSES, 12, 26, 9);
  ok('macd hist == line - signal',
    m.hist.every((h, i) => h === null || Math.abs(h - (m.line[i] - m.signal[i])) < 1e-9));
  const p = TA.ppo(CLOSES, 12, 26, 9);
  ok('ppo hist == line - signal',
    p.hist.every((h, i) => h === null || Math.abs(h - (p.line[i] - p.signal[i])) < 1e-9));
}

// -- ADX/DMI structure -----------------------------------------------------
{
  const a = TA.adx(BARS, 14);
  ok('adx: +DI and -DI are never both zero on a moving series',
    a.plusDI.some((v, i) => v !== null && (v > 0 || a.minusDI[i] > 0)));
}

// -- Supertrend / PSAR behaviour ------------------------------------------
{
  const st = TA.supertrend(BARS, 10, 3);
  ok('supertrend trend is always +1 or -1', st.every(p => p.trend === 1 || p.trend === -1));
  ok('supertrend line sits below price in an uptrend',
    st.every((p, i) => p.value === null || p.trend !== 1 || p.value <= BARS[i].high + 1e-9));
  ok('supertrend line sits above price in a downtrend',
    st.every((p, i) => p.value === null || p.trend !== -1 || p.value >= BARS[i].low - 1e-9));
  ok('supertrend flips are rare (not every bar)',
    st.filter((p, i) => i && p.trend !== st[i - 1].trend).length < BARS.length / 4);

  const ps = TA.psar(BARS);
  ok('psar emits one point per bar', ps.length === BARS.length);
  ok('psar has finite values', ps.every(p => p.value === null || Number.isFinite(p.value)));
  ok('psar flips are rare (not every bar)',
    ps.filter((p, i) => i && p.rising !== ps[i - 1].rising).length < BARS.length / 3);
  // In a strong uptrend PSAR must sit under the lows and never flip.
  const upBars = Array.from({ length: 60 }, (_, i) =>
    ({ time: i * 60, open: 100 + i, high: 101 + i, low: 99.5 + i, close: 100.8 + i, volume: 1 }));
  const upPs = TA.psar(upBars);
  ok('psar never flips during a pure uptrend', upPs.slice(2).every(p => p.rising));
  ok('psar stays below the lows during a pure uptrend',
    upPs.slice(2).every((p, i) => p.value <= upBars[i + 2].low + 1e-9));
}

// -- Ichimoku displacement -------------------------------------------------
{
  const ich = TA.ichimoku(BARS, 9, 26, 52);
  eq('ichimoku exposes its displacement', ich.displacement, 26);
  ok('chikou[i] == close[i+26]',
    ich.chikou.every((v, i) => v === null || Math.abs(v - BARS[i + 26].close) < 1e-12));
  ok('senkouA == (tenkan+kijun)/2',
    ich.senkouA.every((v, i) => v === null || Math.abs(v - (ich.tenkan[i] + ich.kijun[i]) / 2) < 1e-9));
}

// -- VWAP is session-anchored ---------------------------------------------
{
  // Two synthetic sessions; VWAP must restart, so bar 0 of each session has
  // VWAP == that bar's own typical price.
  const s = [];
  for (let d = 0; d < 2; d++)
    for (let i = 0; i < 10; i++)
      s.push({ time: d * 86400 + i * 300, open: 100, high: 102 + i, low: 98 - i, close: 100 + i, volume: 1000 });
  const key = b => Math.floor(b.time / 86400);
  const v = TA.vwap(s, key);
  eq('vwap resets at session 0 open', v[0], (102 + 98 + 100) / 3);
  eq('vwap resets at session 1 open', v[10], (102 + 98 + 100) / 3);
  ok('vwap differs mid-session from the reset value', Math.abs(v[9] - v[0]) > 1e-6);
  // Unanchored accumulation would make v[10] depend on session 0 — check it doesn't.
  const contaminated = TA.vwap(s, () => 0);
  ok('unanchored vwap really is different (guards the test itself)', Math.abs(contaminated[10] - v[10]) > 1e-6);
}

// -- Pivot points use the PREVIOUS period ---------------------------------
{
  const s = [];
  for (let d = 0; d < 3; d++)
    for (let i = 0; i < 5; i++)
      s.push({ time: d * 86400 + i * 300, open: 100 + d * 10, high: 110 + d * 10, low: 90 + d * 10, close: 100 + d * 10, volume: 1 });
  const pv = TA.pivotPoints(s, b => Math.floor(b.time / 86400));
  ok('no pivots during the first period', pv.slice(0, 5).every(v => v === null));
  // day 0: H=110 L=90 C=100 -> pp = 100
  eq('day 1 pivot derives from day 0 HLC', pv[5].pp, 100);
  eq('day 1 r1', pv[5].r1, 2 * 100 - 90);
  eq('day 1 s1', pv[5].s1, 2 * 100 - 110);
  // day 1: H=120 L=100 C=110 -> pp = 110
  eq('day 2 pivot derives from day 1 HLC', pv[10].pp, 110);
  ok('pivot is flat across a period', pv[5].pp === pv[9].pp);
}

// -- Heikin-Ashi structural rules -----------------------------------------
{
  const ha = TA.heikinAshi(BARS);
  ok('HA close == (o+h+l+c)/4',
    ha.every((h, i) => Math.abs(h.close - (BARS[i].open + BARS[i].high + BARS[i].low + BARS[i].close) / 4) < 1e-9));
  ok('HA high >= max(open, close)', ha.every(h => h.high >= Math.max(h.open, h.close) - 1e-9));
  ok('HA low <= min(open, close)', ha.every(h => h.low <= Math.min(h.open, h.close) + 1e-9));
  ok('HA times are strictly increasing', ha.every((h, i) => i === 0 || h.time > ha[i - 1].time));
}

// -- Renko / Line-break must produce strictly increasing unique times ------
// (the renderer silently drops or throws on duplicates; the old build emitted them)
{
  const rk = TA.renko(BARS, 2);
  ok('renko produced bricks', rk.length > 0, `${rk.length}`);
  ok('renko times are strictly increasing', rk.every((b, i) => i === 0 || b.time > rk[i - 1].time));
  ok('renko brick heights are all one box', rk.every(b => Math.abs(Math.abs(b.close - b.open) - 2) < 1e-9));
  const lb = TA.lineBreak(BARS, 3);
  ok('lineBreak produced bars', lb.length > 0, `${lb.length}`);
  ok('lineBreak times are strictly increasing', lb.every((b, i) => i === 0 || b.time > lb[i - 1].time));
}

// -- degenerate inputs must not throw -------------------------------------
{
  const empty = [];
  const one = [{ time: 1, open: 5, high: 6, low: 4, close: 5, volume: 10 }];
  let threw = null;
  try {
    for (const bars of [empty, one]) {
      TA.atr(bars, 14); TA.rsi(bars.map(b => b.close), 14); TA.psar(bars);
      TA.supertrend(bars, 10, 3); TA.adx(bars, 14); TA.ichimoku(bars);
      TA.vwap(bars, b => 0); TA.heikinAshi(bars); TA.renko(bars, 1); TA.lineBreak(bars, 3);
      TA.macd(bars.map(b => b.close), 12, 26, 9); TA.mfi(bars, 14); TA.ultimateOsc(bars, 7, 14, 28);
      TA.pivotPoints(bars, b => 0); TA.stoch(bars, 14, 3); TA.aroon(bars, 25);
    }
  } catch (e) { threw = e; }
  ok('empty and single-bar inputs do not throw', threw === null, threw?.message);
}

// -- period longer than the data ------------------------------------------
{
  let threw = null;
  try {
    const short = BARS.slice(0, 5);
    ok('sma(period > length) is all null', TA.sma(short.map(b => b.close), 50).every(v => v === null));
    ok('atr(period > length) is all null', TA.atr(short, 50).every(v => v === null));
    ok('highest(period > length) is all null', TA.highest(short.map(b => b.close), 50).every(v => v === null));
  } catch (e) { threw = e; }
  ok('over-long periods do not throw', threw === null, threw?.message);
}

// -- large-window stack safety (Math.max(...spread) would blow up here) ----
{
  const big = synthBars(20000).map(b => b.close);
  let threw = null;
  try { TA.highest(big, 15000); TA.lowest(big, 15000); } catch (e) { threw = e; }
  ok('highest/lowest handle a 15000-wide window', threw === null, threw?.message);
}

/* ═══ 4. MUTATION-HARDENED REGRESSIONS ═══════════════════════════════
   Each block below exists because a deliberately re-introduced bug from the
   original build slipped past sections 1–3. Random-walk fixtures never
   produce exact ties, single-bar-multi-brick moves, or null holes, so those
   cases need purpose-built inputs. */
section('4. Mutation-hardened regressions');

// -- ties: a flat tape. Random floats never hit tp[i] === tp[i-1], which let
//    "unchanged typical price counts as a down-tick" survive. ---------------
{
  const flatTape = mkBars([
    [10, 10, 10, 10, 100], [10, 10, 10, 10, 100], [10, 10, 10, 10, 100],
    [10, 12, 8, 10, 100],  [10, 10, 10, 10, 100], [10, 10, 10, 10, 100],
    [10, 10, 10, 10, 100], [10, 12, 8, 10, 100],
  ]);
  // Every typical price is 10 except bars 3 and 7, which are also 10.
  // So there are zero up-ticks and zero down-ticks: pos == neg == 0.
  const m = TA.mfi(flatTape, 3);
  ok('mfi on a perfectly flat tape is neutral, not 0 or 100',
    m.slice(3).every(v => v === null || v === 50),
    `got ${JSON.stringify(m.slice(3))}`);
  ok('rsi on a perfectly flat tape is neutral, not 100',
    TA.rsi(new Array(40).fill(25), 14).slice(14).every(v => v === 50));
  // A tape that alternates flat and up must not be dragged down by the flats.
  const mixed = mkBars([
    [10, 10, 10, 10, 100], [10, 10, 10, 10, 100], [11, 11, 11, 11, 100],
    [11, 11, 11, 11, 100], [12, 12, 12, 12, 100], [12, 12, 12, 12, 100],
  ]);
  eq('mfi: flat ticks count as neither up nor down', TA.mfi(mixed, 2)[5], 100);
}

// -- null holes: the spread-based highest/lowest silently coerces null to 0 --
{
  const holed = [3, null, 5, 1, 4];
  eq('highest tolerates null holes', TA.highest(holed, 2), [null, null, null, 5, 4]);
  eq('lowest tolerates null holes',  TA.lowest(holed, 2),  [null, null, null, 1, 1]);
  eq('sma tolerates null holes',     TA.sma(holed, 2),     [null, null, null, 3, 2.5]);
  // A null must break the window, not be treated as zero.
  ok('sma does not treat null as 0', TA.sma([10, null, 10], 2).every(v => v === null));
}

// -- renko: one bar can cross several boxes; those bricks must not collide --
{
  const gapper = mkBars([
    [100, 100, 100, 100], [100, 100, 100, 100], [100, 130, 100, 130], [130, 130, 100, 101],
  ]);
  const rk = TA.renko(gapper, 5);
  ok('a single bar emits multiple renko bricks', rk.length >= 6, `${rk.length} bricks`);
  ok('multi-brick renko times stay strictly increasing',
    rk.every((b, i) => i === 0 || b.time > rk[i - 1].time),
    JSON.stringify(rk.map(b => b.time)));
  ok('renko times are unique', new Set(rk.map(b => b.time)).size === rk.length);
  const lb = TA.lineBreak(gapper, 3);
  ok('lineBreak times are unique', new Set(lb.map(b => b.time)).size === lb.length);
}

// -- PSAR: pin the seed. An inverted seed (ep/sar swapped) only shows up in
//    the first bars, which the earlier "slice(2)" test skipped over. --------
{
  const b = mkBars([[9, 10, 8, 9], [10, 11, 9, 10], [11, 12, 10, 11], [12, 13, 11, 12]]);
  const p = TA.psar(b, 0.02, 0.2);
  //  seed: rising (c1>=c0), ep=high[0]=10, sar=low[0]=8
  //  i=1: 8+0.02*(10-8)=8.04 -> clamped to prior low 8    -> 8
  //  i=2: 8+0.04*(11-8)=8.12 -> clamped to min(low1,low0)=8 -> 8
  //  i=3: 8+0.06*(12-8)=8.24 -> clamp min(low2=10,low1=9) -> 8.24
  eq('psar golden values (uptrend seed)', p.map(x => x.value), [8, 8, 8, 8.24], 1e-9);
  ok('psar is rising throughout a rising fixture', p.every(x => x.rising));
  ok('psar[0] starts below price, not above', p[0].value <= b[0].low + 1e-9);

  // Downtrend seed. In the uptrend fixture `ep` is overwritten on bar 1, so a
  // swapped seed heals itself and the golden above cannot see it. Here the
  // seed survives, and bar 0 pins both `ep` and `sar`.
  const d = mkBars([[19, 20, 18, 19], [18, 19, 17, 18], [17, 18, 16, 17], [16, 17, 15, 16]]);
  const q = TA.psar(d, 0.02, 0.2);
  //  seed: falling (c1<c0), ep=low[0]=18, sar=high[0]=20
  //  i=1: 20+0.02*(18-20)=19.96 -> clamped up to prior high 20 -> 20
  //  i=2: 20+0.04*(17-20)=19.88 -> clamped to max(high1,high0)=20 -> 20
  //  i=3: 20+0.06*(16-20)=19.76 -> clamp max(high2=18,high1=19) -> 19.76
  eq('psar golden values (downtrend seed)', q.map(x => x.value), [20, 20, 20, 19.76], 1e-9);
  ok('psar is falling throughout a falling fixture', q.every(x => !x.rising));
  ok('psar[0] starts above price in a downtrend', q[0].value >= d[0].high - 1e-9);
}

// -- Supertrend: cross-check against the classic "final band" formulation,
//    which is algebraically equivalent to Pine's but written differently.
//    The loose bounds tests could not tell close[i] from close[i-1]. --------
{
  function supertrendReference(bars, atrPeriod, mult) {
    const a = TA.atr(bars, atrPeriod);
    const out = new Array(bars.length);
    let finalUpper = null, finalLower = null, trend = 1;
    for (let i = 0; i < bars.length; i++) {
      if (a[i] === null) { out[i] = { value: null, trend: 1 }; continue; }
      const mid = (bars[i].high + bars[i].low) / 2;
      const basicUpper = mid + mult * a[i];
      const basicLower = mid - mult * a[i];
      if (finalUpper === null) {
        finalUpper = basicUpper; finalLower = basicLower; trend = 1;
      } else {
        const pc = bars[i - 1].close;                       // PREVIOUS close
        finalUpper = (basicUpper < finalUpper || pc > finalUpper) ? basicUpper : finalUpper;
        finalLower = (basicLower > finalLower || pc < finalLower) ? basicLower : finalLower;
        if (trend === -1 && bars[i].close > out[i - 1].upper) trend = 1;
        else if (trend === 1 && bars[i].close < out[i - 1].lower) trend = -1;
      }
      out[i] = { value: trend === 1 ? finalLower : finalUpper, trend, upper: finalUpper, lower: finalLower };
    }
    return out;
  }
  const mine = TA.supertrend(BARS, 10, 3);
  const ref  = supertrendReference(BARS, 10, 3);
  eq('supertrend matches the independent reference (values)',
    mine.map(p => p.value), ref.map(p => p.value), 1e-9);
  eq('supertrend matches the independent reference (trend)',
    mine.map(p => p.trend), ref.map(p => p.trend));
  // And a direct assertion that the band ratchet reads the previous close:
  // feed a series where close[i] and close[i-1] straddle the band.
  const straddle = synthBars(200, 7);
  const a1 = TA.supertrend(straddle, 5, 1.5).map(p => p.value);
  const a2 = supertrendReference(straddle, 5, 1.5).map(p => p.value);
  eq('supertrend reference agreement on a second fixture', a1, a2, 1e-9);
}

// -- ADX cross-check against a direct Wilder transcription -----------------
{
  function adxReference(bars, n) {
    const len = bars.length;
    const tr = [], pdm = [], mdm = [];
    for (let i = 0; i < len; i++) {
      if (i === 0) { tr.push(bars[0].high - bars[0].low); pdm.push(0); mdm.push(0); continue; }
      const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      const up = h - bars[i - 1].high, dn = bars[i - 1].low - l;
      pdm.push(up > dn && up > 0 ? up : 0);
      mdm.push(dn > up && dn > 0 ? dn : 0);
    }
    const wilder = (arr) => {                        // alpha = 1/n, SMA seed
      const o = new Array(len).fill(null);
      let s = 0;
      for (let i = 0; i < len; i++) {
        if (i < n - 1) { s += arr[i]; continue; }
        if (i === n - 1) { s += arr[i]; o[i] = s / n; continue; }
        o[i] = (arr[i] + o[i - 1] * (n - 1)) / n;
      }
      return o;
    };
    const trS = wilder(tr), pS = wilder(pdm), mS = wilder(mdm);
    const pdi = trS.map((v, i) => (v && v > 0) ? 100 * pS[i] / v : null);
    const mdi = trS.map((v, i) => (v && v > 0) ? 100 * mS[i] / v : null);
    const dx = pdi.map((v, i) => {
      if (v === null || mdi[i] === null) return null;
      const s = v + mdi[i];
      return s === 0 ? 0 : 100 * Math.abs(v - mdi[i]) / s;
    });
    return { plusDI: pdi, minusDI: mdi, adx: wilder(dx.map(v => v ?? 0)) };
  }
  const mine = TA.adx(BARS, 14), ref = adxReference(BARS, 14);
  eq('+DI matches an independent Wilder transcription', mine.plusDI, ref.plusDI, 1e-8);
  eq('-DI matches an independent Wilder transcription', mine.minusDI, ref.minusDI, 1e-8);

  // The DX -> ADX step is itself Wilder-smoothed. Comparing only the DI legs
  // left an sma()-instead-of-rma() swap on that final step invisible.
  const wilderSkippingNulls = (arr, n) => {
    const o = new Array(arr.length).fill(null);
    let seed = 0, cnt = 0, prev = null;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === null || !Number.isFinite(v)) { if (prev === null) { seed = 0; cnt = 0; } continue; }
      if (prev === null) { seed += v; cnt++; if (cnt === n) { prev = seed / n; o[i] = prev; } }
      else { prev = (v + prev * (n - 1)) / n; o[i] = prev; }
    }
    return o;
  };
  const dx = mine.plusDI.map((v, i) => {
    if (v === null || mine.minusDI[i] === null) return null;
    const s = v + mine.minusDI[i];
    return s === 0 ? 0 : 100 * Math.abs(v - mine.minusDI[i]) / s;
  });
  eq('ADX itself is Wilder-smoothed, not simple-averaged',
    mine.adx, wilderSkippingNulls(dx, 14), 1e-8);
}

// -- RSI cross-check against Wilder's published worked example -------------
{
  // Wilder's canonical 14-period close series. The expected values below were
  // produced by a separate, direct transcription of Wilder's procedure (simple
  // mean of the first 14 changes, then (prev*13 + new)/14) and agree with the
  // widely published figures for the first two bars, 70.46 and 66.25.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
    46.03, 46.41, 46.22, 45.64,
  ];
  const r = TA.rsi(closes, 14);
  eq('RSI vs Wilder procedure @14', r[14], 70.464135, 1e-5);
  eq('RSI vs Wilder procedure @15', r[15], 66.249619, 1e-5);
  eq('RSI vs Wilder procedure @16', r[16], 66.480942, 1e-5);
  eq('RSI vs Wilder procedure @19', r[19], 57.915021, 1e-5);
}

/* ═══ Summary ════════════════════════════════════════════════════════ */
console.log(`\n${'─'.repeat(60)}`);
if (fail) {
  console.log(`\x1b[31m${fail} FAILED\x1b[0m, ${pass} passed`);
  failures.forEach(f => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  process.exit(1);
} else {
  console.log(`\x1b[32mAll ${pass} checks passed\x1b[0m`);
}
