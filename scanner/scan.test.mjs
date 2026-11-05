/* Checks for the dip scanner: the drop/retrace math against hand-computed
   cases and a brute-force reference, and the runner's parsing and retry
   behaviour against canned responses. No network.
   Run: node scanner/scan.test.mjs   (or npm run test:scan) */
import { createRequire } from 'node:module';
import { parseUniverse, parseChart, scan, cleanName, yahooSymbol, PREFILTER, BARS } from './run.mjs';

const require = createRequire(import.meta.url);
const SCAN = require('../src/scan.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* Bars from closes alone: high = low = close, which keeps the arithmetic
   hand-checkable. */
const flat = cs => ({ h: [...cs], l: [...cs], c: [...cs], dv: 5e6 });
const loose = { lookback: 999, minDrop: 0, minRetrace: 0, minPrice: 0, minDollarVol: 0 };

/* ── the two examples the definition is written around ── */
{
  const m = SCAN.evaluate(flat([100, 80, 50, 55, 60]), loose);
  check('100→50→60: drop 50%', near(m.drop, 50));
  check('100→50→60: retraced 20%', near(m.retrace, 20));
  check('100→50→60: peak, trough, close', m.peak === 100 && m.trough === 50 && m.close === 60);
  check('100→50→60: 2 bars down, 2 since low', m.dropDays === 2 && m.sinceLow === 2);

  const s = SCAN.evaluate(flat([100, 95, 90, 91, 92]), loose);
  check('100→90→92: drop 10%', near(s.drop, 10));
  check('100→90→92: retraced 20%', near(s.retrace, 20));
}

/* ── the deepest fall wins, not "highest high then lowest after" ──
   100 → 40 → 105 → 95: the highest high is 105, and the lowest low after it
   is 95, a 9.5% dip. The real story is the 60% crash before it. */
{
  const m = SCAN.evaluate(flat([100, 70, 40, 80, 105, 95]), loose);
  check('deepest drawdown is found', near(m.drop, 60), `got ${m.drop}`);
  check('… and retrace is measured against it', near(m.retrace, (95 - 40) / 60 * 100));
}

/* ── highs and lows, not just closes ── */
{
  const row = { h: [101, 99, 70, 66], l: [98, 60, 52, 61], c: [100, 62, 55, 64], dv: 5e6 };
  const m = SCAN.evaluate(row, loose);
  check('uses the high for the peak', m.peak === 101);
  check('uses the low for the trough', m.trough === 52);
  check('uses the close for the retrace', near(m.retrace, (64 - 52) / (101 - 52) * 100));
  // One bar's own range is not a "drop": a peak must come before its trough.
  const one = SCAN.evaluate({ h: [100, 100, 100], l: [100, 100, 40], c: [100, 100, 99], dv: 1 }, loose);
  check('a drop needs a peak before the trough', near(one.drop, 60) && one.dropDays === 1);
  check('rising series has no drop', SCAN.evaluate(flat([1, 2, 3, 4]), loose).drop === 0);
}

/* ── thresholds ── */
{
  const row = flat([100, 50, 54, 61]);                 // drop 50, retrace 22
  const at = o => SCAN.evaluate(row, { ...loose, ...o }).pass;
  check('passes defaults it meets', at({ minDrop: 30, minRetrace: 20 }));
  check('minDrop gates', !at({ minDrop: 51 }));
  check('minRetrace gates', !at({ minRetrace: 23 }));
  check('maxRetrace gates', !at({ maxRetrace: 21 }));
  check('minPrice gates', !at({ minPrice: 62 }));
  check('minDollarVol gates', !at({ minDollarVol: 6e6 }));
  check('drop exactly at the threshold passes', at({ minDrop: 50 }));
}

/* ── fresh: the day the retracement first crosses the line ── */
{
  const fresh = SCAN.evaluate(flat([100, 50, 55, 62]), { ...loose, minRetrace: 20 });   // 10% → 24%
  check('crossing today is fresh', fresh.fresh);
  const old = SCAN.evaluate(flat([100, 50, 62, 63]), { ...loose, minRetrace: 20 });     // 24% → 26%
  check('already across yesterday is not', !old.fresh);
  const today = SCAN.evaluate({ h: [100, 100, 60], l: [100, 100, 50], c: [100, 100, 59] }, { ...loose, minRetrace: 10 });
  check('low set today, closing 18% off it, is fresh', today.sinceLow === 0 && today.fresh);
}

/* ── lookback: a drop outside the window is not seen ── */
{
  const cs = [100, 50, ...Array(60).fill(55)];
  check('drop inside a long window', near(SCAN.evaluate(flat(cs), { ...loose, lookback: 70 }).drop, 50));
  check('drop outside a short window', SCAN.evaluate(flat(cs), { ...loose, lookback: 30 }).drop === 0);
}

/* ── property: matches a brute-force O(n²) reference, and a window's
   drawdown never exceeds the full series' (what makes prefiltering sound) ── */
{
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let agree = 0, sound = 0;
  const N = 400;
  for (let k = 0; k < N; k++) {
    const n = 5 + Math.floor(rnd() * 150);
    const c = [], h = [], l = [];
    let p = 20 + rnd() * 200;
    for (let i = 0; i < n; i++) {
      p = Math.max(0.5, p * (1 + (rnd() - 0.52) * 0.12));
      const hi = p * (1 + rnd() * 0.04), lo = p * (1 - rnd() * 0.04);
      h.push(hi); l.push(lo); c.push(lo + (hi - lo) * rnd());
    }
    let best = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) best = Math.max(best, (h[i] - l[j]) / h[i]);
    const dd = SCAN.maxDrawdown(h, l);
    if (near(dd ? dd.drop : 0, best, 1e-12)) agree++;
    const lb = 2 + Math.floor(rnd() * n);
    const w = SCAN.maxDrawdown(h, l, n - lb, n);
    if ((w ? w.drop : 0) <= (dd ? dd.drop : 0) + 1e-12) sound++;
  }
  check(`maxDrawdown matches brute force (${agree}/${N})`, agree === N);
  check(`windowed drawdown ≤ full (${sound}/${N})`, sound === N);
}

/* ── dollar volume ── */
check('dollar volume averages the last 20', near(SCAN.dollarVolume(Array(30).fill(10), [...Array(10).fill(0), ...Array(20).fill(100)]), 1000));

/* ── universe parsing ── */
{
  const nasdaq = [
    'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
    'AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N',
    'GOOGL|Alphabet Inc. - Class A Common Stock|Q|N|N|100|N|N',
    'QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N',
    'ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N',
    'ABCDW|Abcd Corp - Warrants|S|N|N|100|N|N',
    'EFGHU|Efgh Acquisition Corp - Units|S|N|N|100|N|N',
    'File Creation Time: 1105202617:00|||||||',
  ].join('\n');
  const other = [
    'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    'BRK.B|Berkshire Hathaway Inc. Class B Common Stock|N|BRK.B|N|100|N|BRK.B',
    'ABR$D|Arbor Realty Trust 6.375% Series D Cumulative Redeemable Preferred Stock|N|ABRpD|N|100|N|ABR-D',
    'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
    'GME|GameStop Corporation Common Stock|N|GME|N|100|N|GME',
    'XYZ|Some Arca Listed Inc Common Stock|P|XYZ|N|100|N|XYZ',
    'AAPL|duplicate should be ignored|N|AAPL|N|100|N|AAPL',
    'File Creation Time: 1105202617:00|||||||',
  ].join('\n');
  const u = parseUniverse(nasdaq, other);
  const syms = u.map(x => x.s).sort().join(',');
  check('universe keeps common stock only', syms === 'AAPL,BRK.B,GME,GOOGL,XYZ', syms);
  const by = Object.fromEntries(u.map(x => [x.s, x]));
  check('nasdaq listings file as NASDAQ', by.AAPL.x === 'NASDAQ');
  check('NYSE code maps', by.GME.x === 'NYSE');
  check('Arca maps to AMEX as TradingView files it', by.XYZ.x === 'AMEX');
  check('names are cleaned', by.AAPL.n === 'Apple Inc.', by.AAPL.n);
  check('class is kept', by.GOOGL.n === 'Alphabet Inc. Class A', by.GOOGL.n);
  check('class kept without a dash', by['BRK.B'].n === 'Berkshire Hathaway Inc. Class B', by['BRK.B'].n);
  check('yahoo symbol for share classes', yahooSymbol('BRK.B') === 'BRK-B');
  check('cleanName on a bare name', cleanName('Tesla, Inc. - Common Stock') === 'Tesla, Inc.');
}

/* ── Yahoo chart parsing ── */
{
  const j = { chart: { result: [{ timestamp: [1, 2, 3, 4], indicators: { quote: [{
    high: [10, null, 12, 13], low: [9, null, 11, 12], close: [9.5, null, 11.5, 12.5], volume: [100, null, 300, 400] }] } }] } };
  const b = parseChart(j);
  check('null days are dropped', b.c.join() === '9.5,11.5,12.5' && b.v.join() === '100,300,400');
  check('last timestamp kept', b.last === 4);
  check('empty result is null', parseChart({ chart: { result: null, error: { code: 'Not Found' } } }) === null);
}

/* ── the runner end to end, against canned Yahoo responses ── */
{
  const chart = closes => ({ chart: { result: [{ timestamp: closes.map((_, i) => 1.7e9 + i * 86400),
    indicators: { quote: [{ high: closes, low: closes, close: closes, volume: closes.map(() => 1e6) }] } }] } });
  const series = {
    DIP: [...Array(100).fill(100), 50, 52, 61],            // drop 50, retrace 22
    CALM: Array(140).fill(100).map((x, i) => x + i * 0.1), // never falls
    PENNY: [0.9, 0.4, 0.5],                                // under $1
    LONG: [...Array(200).fill(100), 70, 75],               // 202 bars → trimmed to BARS
  };
  const calls = {};
  const fake = async url => {
    const sym = decodeURIComponent(/chart\/([^?]+)/.exec(url)[1]);
    calls[sym] = (calls[sym] || 0) + 1;
    if (sym === 'GONE') return { ok: false, status: 404 };
    if (sym === 'BUSY' && calls[sym] < 3) return { ok: false, status: 429 };
    if (sym === 'BUSY') return { ok: true, status: 200, json: async () => chart(series.DIP) };
    if (sym === 'DOWN') return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => chart(series[sym]) };
  };
  const u = ['DIP', 'CALM', 'PENNY', 'LONG', 'GONE', 'BUSY', 'DOWN'].map(s => ({ s, x: 'NYSE', n: s }));
  const out = await scan(u, { fetchFn: fake, concurrency: 3, backoff: 1 });
  const kept = out.rows.map(r => r.s).join(',');
  check('prefilter keeps the fallers', kept === 'BUSY,DIP,LONG', kept);
  check('429 is retried until it answers', calls.BUSY === 3);
  check('404 is not retried and not a failure', calls.GONE === 1 && !out.failedSymbols.includes('GONE'));
  check('5xx retried, then counted as failed', calls.DOWN === 5 && out.failed === 1 && out.failedSymbols[0] === 'DOWN');
  check('series trimmed to the stored window', out.rows.find(r => r.s === 'LONG').c.length === BARS);
  check('header carries the prefilter', out.prefilter.minDrop === PREFILTER.minDrop && out.universe === 7);
  check('asOf is a date', /^\d{4}-\d\d-\d\d$/.test(out.asOf));
  const dip = SCAN.evaluate(out.rows.find(r => r.s === 'DIP'));
  check('a kept row re-evaluates in the panel', dip.pass && near(dip.retrace, 22), JSON.stringify(dip));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
