/* Verification for src/data.js against LIVE Yahoo Finance responses.
   This is the candle-accuracy suite: it asserts the properties a chart needs
   to be truthful — monotonic unique stamps, self-consistent OHLC, no
   synthetic bars, correct exchange-local time, session-aligned grids, and
   split continuity — and cross-checks 1h bars against the 1d bar covering
   the same session.
   Run: node test/data.test.mjs                                            */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = require(path.join(ROOT, 'src', 'data.js'));

// Node has no browser Origin, so hit Yahoo directly and identify ourselves.
// Responses are cached on disk: the suite makes ~20 requests and Yahoo starts
// returning 429 if you re-run it a few times in a row. Delete the cache dir
// (or pass --fresh) to re-validate against the live feed.
import fs from 'node:fs';
import crypto from 'node:crypto';

const CACHE = path.join(ROOT, '.cache');
const FRESH = process.argv.includes('--fresh');
const MAX_AGE_MS = 30 * 60 * 1000;
if (FRESH && fs.existsSync(CACHE)) fs.rmSync(CACHE, { recursive: true, force: true });
fs.mkdirSync(CACHE, { recursive: true });

const realFetch = globalThis.fetch;
let liveHits = 0, cacheHits = 0;
globalThis.fetch = async (url, opts = {}) => {
  const file = path.join(CACHE, crypto.createHash('sha1').update(String(url)).digest('hex') + '.json');
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS) {
    cacheHits++;
    return new Response(fs.readFileSync(file, 'utf8'), { status: 200 });
  }
  const r = await realFetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    },
  });
  liveHits++;
  if (!r.ok) return r;
  const text = await r.text();
  fs.writeFileSync(file, text);
  return new Response(text, { status: 200 });
};
DATA.setDirect(true);

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
};
const section = s => console.log(`\n\x1b[1m${s}\x1b[0m`);
const utcParts = t => {
  const d = new Date(t * 1000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), date: d.toISOString().slice(0, 10) };
};

/* ═══ 1. Structural integrity of real series ═════════════════════════ */
section('1. Structural integrity across symbols and timeframes');

const CASES = [
  ['AAPL', '1d'], ['AAPL', '1h'], ['AAPL', '5m'], ['AAPL', '4h'],
  ['MSFT', '15m'], ['SPY', '1d'], ['BTC-USD', '1h'], ['BTC-USD', '1d'],
  ['NVDA', '30m'], ['TSLA', '1wk'],
];

const fetched = {};
for (const [sym, tf] of CASES) {
  let r;
  try { r = await DATA.fetchBars(sym, tf); }
  catch (e) { ok(`${sym} ${tf}: fetch`, false, e.message); continue; }
  fetched[`${sym}|${tf}`] = r;
  const b = r.bars;
  const tag = `${sym} ${tf}`;

  ok(`${tag}: returns bars`, b.length > 10, `${b.length} bars`);
  ok(`${tag}: time strictly increasing`, b.every((x, i) => i === 0 || x.time > b[i - 1].time));
  ok(`${tag}: no duplicate stamps`, new Set(b.map(x => x.time)).size === b.length);
  ok(`${tag}: high >= max(open, close)`, b.every(x => x.high >= Math.max(x.open, x.close) - 1e-9));
  ok(`${tag}: low <= min(open, close)`, b.every(x => x.low <= Math.min(x.open, x.close) + 1e-9));
  ok(`${tag}: high >= low`, b.every(x => x.high >= x.low));
  ok(`${tag}: all prices positive`, b.every(x => x.open > 0 && x.high > 0 && x.low > 0 && x.close > 0));
  ok(`${tag}: volume non-negative`, b.every(x => x.volume >= 0));
  ok(`${tag}: no NaN anywhere`,
    b.every(x => [x.time, x.open, x.high, x.low, x.close, x.volume].every(Number.isFinite)));
  ok(`${tag}: every bar keeps its true utc stamp`, b.every(x => Number.isFinite(x.utc)));
  // The trailing stub must be gone.
  ok(`${tag}: no synthetic trailing bar survives`, !DATA.isStub(b[b.length - 1]) || b[b.length - 1].volume > 0,
    `last=${JSON.stringify(b[b.length - 1])}`);
  // Last close should agree with the quoted price (they are the same print).
  const drift = Math.abs(b[b.length - 1].close - r.meta.price) / r.meta.price;
  ok(`${tag}: last close tracks the quote`, drift < 0.05, `drift ${(drift * 100).toFixed(2)}%`);
}

/* ═══ 2. Exchange-local time ═════════════════════════════════════════ */
section('2. Exchange-local timestamps (the axis a trader expects)');
{
  const d = fetched['AAPL|1d'];
  if (d) {
    // US equities open 09:30 ET. After shifting, reading the stamp as UTC
    // must show exactly 09:30 — for every bar, across DST changes.
    const bad = d.bars.filter(b => { const p = utcParts(b.time); return !(p.h === 9 && p.m === 30); });
    ok('AAPL daily bars all read 09:30 exchange-local', bad.length === 0,
      `${bad.length} off, e.g. ${bad[0] ? new Date(bad[0].time * 1000).toISOString() : ''}`);
    // Spanning >1y guarantees the sample crosses at least two DST switches.
    const span = (d.bars[d.bars.length - 1].time - d.bars[0].time) / 86400;
    ok('AAPL daily sample spans multiple DST transitions', span > 400, `${Math.round(span)} days`);
    ok('AAPL timezone reported', d.meta.timezone === 'America/New_York', d.meta.timezone);
  }
  const c = fetched['BTC-USD|1d'];
  if (c) {
    const bad = c.bars.filter(b => { const p = utcParts(b.time); return !(p.h === 0 && p.m === 0); });
    ok('BTC daily bars sit at UTC midnight (no shift applied)', bad.length === 0, `${bad.length} off`);
    ok('BTC flagged as 24h', c.meta.is24h === true);
  }
  const h = fetched['AAPL|1h'];
  if (h) {
    // Intraday US equity bars start at :30 past the hour, because the session
    // opens at 09:30 — not on the hour. The exception is a shortened session
    // (13:00 early close), whose final stub bar lands on the hour, so allow
    // :00 only as a session's last bar.
    const byDay = new Map();
    for (const b of h.bars) {
      const d = Math.floor(b.time / 86400);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(b);
    }
    let bad = 0, tail = 0;
    for (const day of byDay.values())
      day.forEach((b, i) => {
        if (utcParts(b.time).m === 30) return;
        if (i === day.length - 1) tail++; else bad++;
      });
    ok('AAPL 1h bars are session-anchored to :30', bad === 0, `${bad} mid-session bars off the :30 grid`);
    ok('off-grid 1h bars are only session-closing stubs', tail < byDay.size, `${tail} of ${byDay.size} sessions`);
  }
  const f = fetched['AAPL|4h'];
  if (f) {
    const hours = new Set(f.bars.map(b => utcParts(b.time).h));
    ok('AAPL 4h bars anchor to the session, not UTC 00/04/08',
      [...hours].every(x => x === 9 || x === 13), `hours seen: ${[...hours].join(',')}`);
  }
}

/* ═══ 3. Grid alignment within a session ═════════════════════════════ */
section('3. Intraday bars land on the interval grid');
for (const key of ['AAPL|5m', 'MSFT|15m', 'NVDA|30m']) {
  const r = fetched[key];
  if (!r) continue;
  const secs = r.meta.tfSecs;
  // Group by exchange-local day, then check each day's bars sit on a grid
  // whose origin is that day's first bar.
  const byDay = new Map();
  for (const b of r.bars) {
    const d = Math.floor(b.time / 86400);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(b);
  }
  let offGrid = 0, total = 0;
  for (const day of byDay.values()) {
    const origin = day[0].time;
    for (const b of day) { total++; if ((b.time - origin) % secs !== 0) offGrid++; }
  }
  ok(`${key}: every bar is on the session grid`, offGrid === 0, `${offGrid}/${total} off-grid`);
  ok(`${key}: session count is plausible`, byDay.size >= 3, `${byDay.size} sessions`);
}

/* ═══ 4. Cross-check: 1h bars must reconstruct the 1d bar ════════════ */
section('4. Cross-timeframe consistency (1h aggregated vs the 1d bar)');
{
  const day = fetched['AAPL|1d'], hour = fetched['AAPL|1h'];
  if (day && hour) {
    const dayByKey = new Map(day.bars.map(b => [Math.floor(b.time / 86400), b]));
    let checked = 0, agree = 0, worst = 0, worstDay = '';
    const byDay = new Map();
    for (const b of hour.bars) {
      const k = Math.floor(b.time / 86400);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(b);
    }
    for (const [k, hrs] of byDay) {
      const d = dayByKey.get(k);
      if (!d || hrs.length < 6) continue;          // skip half-days/missing
      checked++;
      const hi = Math.max(...hrs.map(x => x.high));
      const lo = Math.min(...hrs.map(x => x.low));
      const o = hrs[0].open, c = hrs[hrs.length - 1].close;
      const err = Math.max(
        Math.abs(hi - d.high) / d.high,
        Math.abs(lo - d.low) / d.low,
        Math.abs(o - d.open) / d.open,
        Math.abs(c - d.close) / d.close,
      );
      if (err > worst) { worst = err; worstDay = new Date(k * 86400 * 1000).toISOString().slice(0, 10); }
      if (err < 0.005) agree++;                    // 0.5% tolerance
    }
    ok('1h bars reconstruct the daily OHLC', checked > 20 && agree / checked > 0.9,
      `${agree}/${checked} days agree, worst ${(worst * 100).toFixed(2)}% on ${worstDay}`);
  }
}

/* ═══ 5. Split and dividend adjustment ═══════════════════════════════ */
section('5. Corporate actions');
{
  // AAPL split 4:1 on 2020-08-31. With split-adjusted OHLC (the default) the
  // series must be continuous across it; an unadjusted feed shows a 4x cliff.
  const url = `${DATA.YF}/v8/finance/chart/AAPL?interval=1d&period1=1597881600&period2=1599696000&events=div%2Csplit`;
  const json = await DATA.getJSON(url);
  const r = DATA.parseChart(json, '1d');
  let maxJump = 0;
  for (let i = 1; i < r.bars.length; i++)
    maxJump = Math.max(maxJump, Math.abs(r.bars[i].close / r.bars[i - 1].close - 1));
  ok('AAPL is continuous through its 4:1 split (already split-adjusted)', maxJump < 0.15,
    `largest day-over-day move ${(maxJump * 100).toFixed(1)}%`);

  // Dividend adjustment must actually change a dividend payer's history, and
  // must leave the most recent bar alone (the factor converges to 1).
  const koRaw = await DATA.fetchBars('KO', '1d', { range: '2y' });
  const koAdj = await DATA.fetchBars('KO', '1d', { range: '2y', dividendAdjusted: true });
  const n = Math.min(koRaw.bars.length, koAdj.bars.length);
  ok('dividend adjustment lowers older KO closes', koAdj.bars[0].close < koRaw.bars[0].close,
    `${koAdj.bars[0].close.toFixed(2)} vs ${koRaw.bars[0].close.toFixed(2)}`);
  ok('dividend adjustment is a no-op on the latest bar',
    Math.abs(koAdj.bars[n - 1].close - koRaw.bars[n - 1].close) < 0.01);
  ok('dividend adjustment scales the whole candle, not just the close',
    koAdj.bars[0].high / koRaw.bars[0].high - koAdj.bars[0].close / koRaw.bars[0].close < 1e-6);
}

/* ═══ 6. Live-tick logic ═════════════════════════════════════════════ */
section('6. Live tick handling (the fake-candle regression)');
{
  const mkMeta = (over = {}) => ({
    tfSecs: 60, timezone: 'America/New_York', is24h: false,
    sessionStart: 1786109400, sessionEnd: 1786132800, ...over,
  });
  // Real bars carry a shifted display stamp alongside the true utc stamp;
  // the fixture must mirror that or it is not testing what ships.
  const mkBars = (t0, n, secs) => Array.from({ length: n }, (_, i) => {
    const utc = t0 + i * secs;
    return { time: utc + DATA.tzOffset(utc, 'America/New_York'), utc, open: 100, high: 101, low: 99, close: 100, volume: 10 };
  });

  // Market shut: must refuse to invent anything. This is the bug that filled
  // overnight 1m charts with hundreds of flat candles.
  {
    const bars = mkBars(1786109400, 5, 60);
    const before = bars.length;
    const res = DATA.applyTick(bars, mkMeta(), 123, 1786132800 + 3600); // after the close
    ok('closed market: no tick applied', res === null);
    ok('closed market: no bar appended', bars.length === before);
  }
  // Inside the session, same bucket: extend the forming bar.
  {
    const bars = mkBars(1786109400, 5, 60);
    const last = bars[bars.length - 1];
    const res = DATA.applyTick(bars, mkMeta(), 105, last.utc + 30);
    ok('open market, same bucket: extends in place', res && res.isNew === false);
    ok('open market: high ratchets up', last.high === 105);
    ok('open market: close follows the tick', last.close === 105);
    const res2 = DATA.applyTick(bars, mkMeta(), 95, last.utc + 40);
    ok('open market: low ratchets down', last.low === 95 && res2.isNew === false);
  }
  // Next bucket inside the session: exactly one new bar.
  {
    const bars = mkBars(1786109400, 5, 60);
    const n = bars.length;
    const res = DATA.applyTick(bars, mkMeta(), 110, bars[n - 1].utc + 65);
    ok('new bucket inside session: appends one bar', res && res.isNew === true && bars.length === n + 1);
    ok('new bar opens at the tick price', bars[bars.length - 1].open === 110);
    ok('new bar sits on the grid', (bars[bars.length - 1].time - bars[0].time) % 60 === 0);
  }
  // A gap that would land past the close must not open a bar.
  {
    const bars = mkBars(1786132800 - 120, 2, 60);
    const n = bars.length;
    DATA.applyTick(bars, mkMeta(), 110, 1786132800 - 1);
    ok('a bucket past the session end is not opened', bars.length === n);
  }
  // Daily bars extend while the session is live and never roll on their own.
  {
    const t = 1786109400 + DATA.tzOffset(1786109400, 'America/New_York');
    const bars = [{ time: t, utc: 1786109400, open: 100, high: 101, low: 99, close: 100, volume: 10 }];
    const meta = mkMeta({ tfSecs: 86400 });
    const res = DATA.applyTick(bars, meta, 108, 1786109400 + 3600);
    ok('daily bar updates live during its session', res && res.isNew === false && bars[0].close === 108);
    ok('daily bar does not roll to a new day on its own',
      DATA.applyTick(bars, meta, 108, 1786109400 + 86400 * 2) === null && bars.length === 1);
  }
  // 24h instruments have no session gate.
  {
    const bars = mkBars(1786100000, 3, 3600);
    const meta = { tfSecs: 3600, timezone: 'UTC', is24h: true, sessionStart: null, sessionEnd: null };
    ok('crypto ticks apply at any hour',
      DATA.applyTick(bars, meta, 150, bars[2].utc + 10) !== null);
    ok('crypto market always reads as open', DATA.marketOpen(meta, 0) === true);
  }
}

/* ═══ 7. Stub detection unit checks ══════════════════════════════════ */
section('7. Synthetic-bar detection');
{
  const flat0 = { open: 5, high: 5, low: 5, close: 5, volume: 0 };
  const flatV = { open: 5, high: 5, low: 5, close: 5, volume: 1200 };
  const real  = { open: 5, high: 6, low: 4, close: 5.5, volume: 0 };
  ok('flat zero-volume bar is a stub', DATA.isStub(flat0) === true);
  ok('flat bar WITH volume is not a stub', DATA.isStub(flatV) === false);
  ok('zero-volume bar with a real range is not a stub', DATA.isStub(real) === false);
  // Full parse path: a stub must be folded into the previous bar, not dropped.
  const synthetic = {
    chart: { result: [{
      meta: { symbol: 'X', exchangeTimezoneName: 'UTC', instrumentType: 'CRYPTOCURRENCY', regularMarketPrice: 12 },
      timestamp: [1000, 1060, 1071],
      indicators: { quote: [{ open: [10, 11, 12], high: [10.5, 11.5, 12], low: [9.5, 10.5, 12], close: [10.2, 11.2, 12], volume: [100, 200, 0] }] },
    }] },
  };
  const parsed = DATA.parseChart(synthetic, '1m');
  ok('stub is removed from the series', parsed.bars.length === 2);
  ok('stub price is folded into the forming bar', parsed.bars[1].close === 12);
  ok('folding widens the forming bar high', parsed.bars[1].high === 12);
  ok('livePrice is surfaced', parsed.livePrice === 12);
}

/* ═══ 8. Session and period keys ═════════════════════════════════════ */
section('8. Session / period keys used by VWAP and pivots');
{
  const r = fetched['AAPL|5m'];
  if (r) {
    const keys = r.bars.map(DATA.sessionKey);
    const distinct = new Set(keys).size;
    ok('5m bars split into multiple sessions', distinct >= 3, `${distinct} sessions`);
    ok('session key is non-decreasing', keys.every((k, i) => i === 0 || k >= keys[i - 1]));
    // A US session must never straddle two keys.
    const byKey = new Map();
    for (let i = 0; i < r.bars.length; i++) {
      const k = keys[i];
      byKey.set(k, (byKey.get(k) || 0) + 1);
    }
    const counts = [...byKey.values()];
    ok('each full session has a plausible bar count', counts.filter(c => c > 90).length === 0,
      `max ${Math.max(...counts)} bars/session (5m regular session = 78)`);
  }
  const pk = DATA.periodKeyFor('1d');
  const b1 = { time: Date.UTC(2026, 0, 15) / 1000 }, b2 = { time: Date.UTC(2026, 1, 3) / 1000 };
  ok('daily pivots key by calendar month', pk(b1) !== pk(b2));
  ok('same month shares a pivot key', pk(b1) === pk({ time: Date.UTC(2026, 0, 28) / 1000 }));
  const pi = DATA.periodKeyFor('5m');
  ok('intraday pivots key by day',
    pi({ time: 86400 * 10 }) !== pi({ time: 86400 * 11 }) && pi({ time: 86400 * 10 + 3600 }) === pi({ time: 86400 * 10 }));
}

/* ═══ 9. Quotes, search, errors ══════════════════════════════════════ */
section('9. Quotes, search and error handling');
{
  const q = await DATA.fetchQuote('AAPL');
  ok('quote: price present', q.price > 0);
  ok('quote: previous close present', q.previousClose > 0);
  ok('quote: change matches price - previousClose',
    Math.abs(q.change - (q.price - q.previousClose)) < 1e-6);
  ok('quote: percent matches', Math.abs(q.changePct - q.change / q.previousClose * 100) < 1e-6);
  ok('quote: 52w high >= 52w low', q.fiftyTwoWeekHigh >= q.fiftyTwoWeekLow);
  ok('quote: name resolved', !!q.name && q.name !== 'AAPL');

  const many = await DATA.fetchQuotes(['AAPL', 'MSFT', 'NVDA', 'BADSYMBOLXYZ']);
  ok('batch quotes drop unresolvable symbols', many.length === 3, `${many.length} returned`);
  ok('batch quotes keep request order', many[0].symbol === 'AAPL' && many[2].symbol === 'NVDA');

  const hits = await DATA.search('apple');
  ok('search returns AAPL', hits.some(h => h.symbol === 'AAPL'), hits.map(h => h.symbol).join(','));

  let threw = false;
  try { await DATA.fetchBars('ZZZZ-NOT-REAL', '1d'); } catch { threw = true; }
  ok('unknown symbol raises rather than returning junk', threw);
}

/* ═══ Summary ════════════════════════════════════════════════════════ */
console.log(`\n${'─'.repeat(64)}`);
if (fail) {
  console.log(`\x1b[31m${fail} FAILED\x1b[0m, ${pass} passed`);
  failures.forEach(f => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  process.exit(1);
} else {
  console.log(`\x1b[32mAll ${pass} checks passed against live Yahoo data\x1b[0m`);
}
