/* Checks for the dip scanner: the drop/retrace math against hand-computed
   cases and a brute-force reference, and the runner's parsing and retry
   behaviour against canned responses. No network.
   Run: node scanner/scan.test.mjs   (or npm run test:scan) */
import { createRequire } from 'node:module';
import { parseUniverse, parseChart, scan, cleanName, yahooSymbol, getSession, Blocked, AuthError, PREFILTER, BARS } from './run.mjs';

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

/* ── maxJump: the biggest one-day gain since the low ── */
{
  const spike = flat([100, 50, 51, 70, 71]);           // +37% on one day
  const steady = flat([100, 50, 54, 58, 62, 66, 71]);  // ≤8% a day
  const ms = SCAN.evaluate(spike, loose), mt = SCAN.evaluate(steady, loose);
  check('jump: spike measured', near(ms.jump, (70 / 51 - 1) * 100));
  check('jump: steady climb measured', mt.jump < 8.1 && mt.jump > 7);
  check('jump: maxJump gates the spike', !SCAN.evaluate(spike, { ...loose, maxJump: 10 }).pass);
  check('jump: …and passes the steady one', SCAN.evaluate(steady, { ...loose, maxJump: 10 }).pass);
  // The crash into the low is not a "jump", and days before the low don't count.
  const preSpike = flat([60, 100, 50, 52, 55]);        // +67% before the low
  check('jump: only days after the low count', SCAN.evaluate(preSpike, loose).jump < 6);
  check('jump: default allows anything', SCAN.evaluate(spike, loose).pass);
}

/* ── sharp dips from a high: maxDropDays and highLookback ── */
{
  const sharp = flat([...Array(10).fill(80), 90, 100, 70, 50, 60, 76]);       // up to a high, −50% in 2 days
  const slide = flat([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 60, 76]);  // a 10-day grind down
  const fromHigh = { ...loose, minRetrace: 50 };
  const ms = SCAN.evaluate(sharp, fromHigh), ml = SCAN.evaluate(slide, fromHigh);
  check('sharp: drop days measured', ms.dropDays === 2 && ml.dropDays === 10);
  check('sharp: maxDropDays keeps the fast drop', SCAN.evaluate(sharp, { ...fromHigh, maxDropDays: 5 }).pass);
  check('sharp: …and drops the slow slide', !SCAN.evaluate(slide, { ...fromHigh, maxDropDays: 5 }).pass);
  check('sharp: highFor counts the sessions the high tops', ms.highFor === 11 && ml.highFor === 0);
  check('sharp: highLookback keeps a dip from a high', SCAN.evaluate(sharp, { ...fromHigh, highLookback: 10 }).pass);
  const lowerHigh = flat([120, ...Array(9).fill(80), 90, 100, 70, 50, 60, 76]);   // a higher high 11 sessions back
  check('sharp: …and drops one below an earlier high', !SCAN.evaluate(lowerHigh, { ...fromHigh, lookback: 7, highLookback: 15 }).pass);
  check('sharp: off by default', SCAN.evaluate(slide, fromHigh).pass);
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
  check('5xx retried, then counted as failed', calls.DOWN === 4 && out.failed === 1 && out.failedSymbols[0] === 'DOWN');
  check('failures are tallied by reply', out.errors['HTTP 503'] === 1, JSON.stringify(out.errors));
  check('series trimmed to the stored window', out.rows.find(r => r.s === 'LONG').c.length === BARS);
  check('header carries the prefilter', out.prefilter.minDrop === PREFILTER.minDrop && out.universe === 7);
  check('asOf is a date', /^\d{4}-\d\d-\d\d$/.test(out.asOf));
  const dip = SCAN.evaluate(out.rows.find(r => r.s === 'DIP'));
  check('a kept row re-evaluates in the panel', dip.pass && near(dip.retrace, 22), JSON.stringify(dip));
}

/* ── Yahoo session: cookie from fc.yahoo.com, crumb from getcrumb ── */
const res = (status, body = '', setCookie = []) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => body, json: async () => JSON.parse(body),
  headers: { getSetCookie: () => setCookie },
});
const tinyChart = JSON.stringify({ chart: { result: [{ timestamp: [1, 2, 3],
  indicators: { quote: [{ high: [100, 50, 61], low: [100, 50, 61], close: [100, 50, 61], volume: [1e6, 1e6, 1e6] }] } }] } });
{
  const seen = [];
  const yahoo = async (url, init = {}) => {
    seen.push({ url, cookie: init.headers?.Cookie });
    if (url.startsWith('https://fc.yahoo.com')) return res(404, 'nope', ['A3=d=AQAB; Expires=Fri; Domain=.yahoo.com; Path=/; Secure']);
    if (url.includes('/v1/test/getcrumb')) return init.headers?.Cookie === 'A3=d=AQAB' ? res(200, 'abc.DEF/9') : res(401, '<html>');
    const crumb = new URL(url).searchParams.get('crumb');
    return crumb === 'abc.DEF/9' && init.headers?.Cookie === 'A3=d=AQAB' ? res(200, tinyChart) : res(429, 'Too Many Requests');
  };
  const sess = await getSession(yahoo);
  check('session takes the cookie from fc.yahoo.com', sess.cookie === 'A3=d=AQAB', sess.cookie);
  check('session gets a crumb with it', sess.crumb === 'abc.DEF/9', sess.crumb);
  const out = await scan([{ s: 'DIP', x: 'NYSE', n: 'Dip' }], { fetchFn: yahoo, backoff: 1 });
  const chartCall = seen.find(c => c.url.includes('/v8/finance/chart/'));
  check('chart requests carry the crumb', chartCall && new URL(chartCall.url).searchParams.get('crumb') === 'abc.DEF/9');
  check('chart requests carry the cookie', chartCall?.cookie === 'A3=d=AQAB');
  check('a session-authenticated scan succeeds', out.rows.length === 1 && out.failed === 0);

  const pageNotCrumb = async url => url.includes('getcrumb') ? res(200, '<!doctype html><html>') : res(404, '', []);
  check('an HTML page is not taken for a crumb', (await getSession(pageNotCrumb)).crumb === '');
}

/* ── an expired session (401) is renewed once, shared by all workers ── */
{
  let handshakes = 0, chartCalls = 0;
  const expiring = async (url, init = {}) => {
    if (url.startsWith('https://fc.yahoo.com')) return res(404, '', [`A3=s${handshakes}`]);
    if (url.includes('getcrumb')) { handshakes++; return res(200, `c${handshakes}`); }
    chartCalls++;
    return new URL(url).searchParams.get('crumb') === 'c2' ? res(200, tinyChart) : res(401, 'Unauthorized');
  };
  const u = Array.from({ length: 8 }, (_, i) => ({ s: 'S' + i, x: 'NYSE', n: '' }));
  const out = await scan(u, { fetchFn: expiring, backoff: 1, concurrency: 4 });
  check('401 renews the session and succeeds', out.failed === 0 && out.rows.length === 8, JSON.stringify(out.errors));
  check('…with one renewal, not one per worker', handshakes === 2, `handshakes ${handshakes}`);
}

/* ── blocked: stop after the probe instead of grinding through the rest ── */
{
  let calls = 0;
  const refusing = async url => {
    if (url.startsWith('https://fc.yahoo.com') || url.includes('getcrumb')) return res(429, 'Too Many Requests');
    calls++; return res(429, 'Too Many Requests');
  };
  const u = Array.from({ length: 2000 }, (_, i) => ({ s: 'B' + i, x: 'NYSE', n: '' }));
  let err = null;
  try { await scan(u, { fetchFn: refusing, backoff: 1, probe: 60, concurrency: 6 }); } catch (e) { err = e; }
  check('a blocked run throws Blocked', err instanceof Blocked, String(err));
  check('…naming what Yahoo answered', /HTTP 429/.test(err?.message || ''), err?.message);
  check('…after the probe, not the whole universe', calls < 70 * 4, `${calls} chart calls`);

  // A run that is merely patchy is not blocked.
  let n = 0;
  const patchy = async url => {
    if (url.startsWith('https://fc.yahoo.com') || url.includes('getcrumb')) return res(200, 'ok1');
    return (n++ % 3 === 0) ? res(400, 'bad') : res(200, tinyChart);
  };
  const v = Array.from({ length: 150 }, (_, i) => ({ s: 'P' + i, x: 'NYSE', n: '' }));
  const out = await scan(v, { fetchFn: patchy, backoff: 1 });
  check('a patchy run completes', out.universe === 150 && out.failed > 0 && out.rows.length > 0);
}

/* ── Alpaca: many symbols per request, paged, with keys in two headers ── */
{
  const day = i => new Date(Date.UTC(2026, 5, 1) + i * 864e5).toISOString();
  const barsOf = closes => closes.map((c, i) => ({ t: day(i), o: c, h: c, l: c, c, v: 1e6 }));
  const DATA = {
    DIP: barsOf([...Array(100).fill(100), 50, 52, 61]),   // drop 50, retrace 22
    CALM: barsOf(Array(120).fill(100).map((x, i) => x + i)),
    'BRK.B': barsOf([...Array(60).fill(500), 300, 360]),
  };
  const reqs = [];
  // Serves pages of at most 50 bars across symbols, like Alpaca's `limit`,
  // so DIP is split over a page break.
  const alpaca = async (url, init = {}) => {
    const u = new URL(url);
    reqs.push({ u, h: init.headers || {} });
    if (init.headers?.['APCA-API-SECRET-KEY'] !== 'sec') return res(401, '{"message":"forbidden."}');
    const syms = u.searchParams.get('symbols').split(',');
    const flat = syms.flatMap(s => (DATA[s] || []).map(b => [s, b]));
    const from = +(u.searchParams.get('page_token') || 0);
    const page = flat.slice(from, from + 50), bars = {};
    for (const [s, b] of page) (bars[s] ||= []).push(b);
    return res(200, JSON.stringify({ bars, next_page_token: from + 50 < flat.length ? String(from + 50) : null }));
  };
  const u = ['DIP', 'CALM', 'BRK.B', 'GONE'].map(s => ({ s, x: 'NYSE', n: s }));
  const now = Date.UTC(2026, 10, 6, 22, 0);
  const out = await scan(u, { source: 'alpaca', fetchFn: alpaca, key: 'kid', secret: 'sec', backoff: 1, now });
  const r0 = reqs[0];
  check('alpaca: both key headers sent', r0.h['APCA-API-KEY-ID'] === 'kid' && r0.h['APCA-API-SECRET-KEY'] === 'sec');
  check('alpaca: one request names all four symbols', r0.u.searchParams.get('symbols') === 'DIP,CALM,BRK.B,GONE');
  check('alpaca: daily, consolidated, split-adjusted, ascending', ['timeframe=1Day', 'feed=sip', 'adjustment=split', 'sort=asc'].every(q => r0.u.search.includes(q)));
  check('alpaca: window ends past the 15-minute embargo', Date.parse(r0.u.searchParams.get('end')) <= now - 15 * 60e3);
  check('alpaca: window starts far enough back for BARS sessions', (now - Date.parse(r0.u.searchParams.get('start'))) / 864e5 >= BARS * 1.4);
  check('alpaca: follows page tokens', reqs.length === 6, `${reqs.length} requests`);
  const dip = out.rows.find(r => r.s === 'DIP');
  check('alpaca: a symbol split across pages is whole', dip && dip.c.length === 103, dip && String(dip.c.length));
  check('alpaca: kept rows evaluate', SCAN.evaluate(dip).pass);
  check('alpaca: share classes keep their dot', out.rows.some(r => r.s === 'BRK.B'));
  check('alpaca: no data is not a failure', out.failed === 0 && out.universe === 4);
  check('alpaca: output names the source', out.source === 'Alpaca');
  check('alpaca: asOf is the latest bar of any symbol', out.asOf === day(119).slice(0, 10), out.asOf);

  let err = null;
  try { await scan(u, { source: 'alpaca', fetchFn: alpaca, key: 'kid', secret: 'wrong', backoff: 1, now }); } catch (e) { err = e; }
  check('alpaca: a rejected key stops the run with AuthError', err instanceof AuthError && /401/.test(err.message), String(err));

  // A batch whose second page fails is discarded whole: DIP's bars run over
  // that page break, and scanning half a series would misreport it.
  const secondPageFails = async (url, init) => new URL(url).searchParams.get('page_token') === '50'
    ? res(503, 'busy') : alpaca(url, init);
  const outP = await scan(u, { source: 'alpaca', fetchFn: secondPageFails, key: 'kid', secret: 'sec', backoff: 1, now });
  check('alpaca: a batch failing mid-pages keeps nothing', outP.rows.length === 0 && outP.failed === 4, `rows ${outP.rows.length}, failed ${outP.failed}`);

  // 450 symbols → 3 batches of ≤200; a batch that keeps failing fails whole.
  const big = Array.from({ length: 450 }, (_, i) => ({ s: 'Z' + i, x: 'NYSE', n: '' }));
  const sizes = [];
  let flaky = 0;
  const batching = async url => {
    const n = new URL(url).searchParams.get('symbols').split(',');
    sizes.push(n.length);
    if (n[0] === 'Z200') { flaky++; return res(503, 'busy'); }
    return res(200, JSON.stringify({ bars: {}, next_page_token: null }));
  };
  const outB = await scan(big, { source: 'alpaca', fetchFn: batching, key: 'k', secret: 's', backoff: 1, probe: 1000 });
  check('alpaca: batches of at most 200', sizes.filter((_, i) => i === sizes.indexOf(sizes[i])).every(n => n <= 200) && Math.max(...sizes) === 200);
  check('alpaca: a failing batch is retried, then fails whole', flaky === 4 && outB.failed === 200 && outB.errors['HTTP 503'] === 200, JSON.stringify(outB.errors));

  // Blocked names Alpaca, not Yahoo.
  const refuse = async () => res(429, 'slow down');
  let berr = null;
  try { await scan(big, { source: 'alpaca', fetchFn: refuse, key: 'k', secret: 's', backoff: 1, tries: 2 }); } catch (e) { berr = e; }
  check('alpaca: blocked run names Alpaca', berr instanceof Blocked && /^Alpaca refused/.test(berr.message), berr?.message);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
