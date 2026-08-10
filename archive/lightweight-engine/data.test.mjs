/* Verification for src/data.js against the LIVE Alpaca market data API.
   The candle-accuracy suite. It asserts the properties a chart needs to be
   truthful — monotonic unique stamps, self-consistent OHLC, exchange-local
   time across DST, session grids that respect half-days — and it pins the
   auction prints against ground truth established independently:

     AAPL 2026-08-04  official open  302.73
     AAPL 2026-08-07  official open  311.45   official close 313.33

   Yahoo's intraday feed missed all of these. Alpaca's SIP feed must not.

   Credentials come from ~/trading-dashboard/.env (paper keys, read-only
   market-data endpoints; no trading endpoint is ever called).
   Run: node test/data.test.mjs                                            */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const DATA = require(path.join(HERE, 'data.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (name, actual, expected, tol = 1e-9) =>
  ok(name, actual != null && Math.abs(actual - expected) <= tol, `${actual} != ${expected}`);
const section = s => console.log(`\n\x1b[1m${s}\x1b[0m`);

/* ── credentials ─────────────────────────────────────────────────────── */
function loadEnvCreds() {
  const candidates = [
    process.env.ALPACA_ENV,
    path.join(os.homedir(), 'trading-dashboard', '.env'),
    path.join(ROOT, '.env'),
  ].filter(Boolean);
  for (const f of candidates) {
    if (!f || !fs.existsSync(f)) continue;
    const env = Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    const key = env.APCA_API_KEY_ID || env.ALPACA_KEY_ID;
    const secret = env.APCA_API_SECRET_KEY || env.ALPACA_SECRET_KEY;
    if (key && secret) return { key, secret, paper: /^PK/.test(key) };
  }
  return null;
}
const c = loadEnvCreds();
if (!c) {
  console.error('No Alpaca credentials found. Set ALPACA_ENV to a .env with '
    + 'APCA_API_KEY_ID and APCA_API_SECRET_KEY, or place one at ~/trading-dashboard/.env');
  process.exit(2);
}
DATA.setCreds(c.key, c.secret, c.paper);
console.log(`using ${c.paper ? 'paper' : 'live'} key ${c.key.slice(0, 4)}…`);

const utcParts = t => { const d = new Date(t * 1000); return { h: d.getUTCHours(), m: d.getUTCMinutes() }; };
const dayOf = b => Math.floor(b.time / 86400);

/* ═══ 1. Symbol classification ═══════════════════════════════════════ */
section('1. Symbol handling');
{
  ok('plain equity', DATA.classify('aapl').symbol === 'AAPL' && !DATA.classify('aapl').crypto);
  ok('dotted class shares', DATA.classify('BRK-B').symbol === 'BRK.B');
  ok('BTC-USD becomes a pair', DATA.classify('BTC-USD').symbol === 'BTC/USD' && DATA.classify('BTC-USD').crypto);
  ok('BTCUSD becomes a pair', DATA.classify('BTCUSD').symbol === 'BTC/USD');
  ok('explicit pair passes through', DATA.classify('ETH/USD').symbol === 'ETH/USD');
  ok('a ticker that merely ends in USD is not crypto', DATA.classify('THUSD').crypto === false);
  let msg = '';
  try { DATA.classify('^GSPC'); } catch (e) { msg = e.message; }
  ok('indices are rejected with a usable message', /index/i.test(msg) && /SPY/.test(msg), msg);
  ok('index rejection is a NotFound', (() => { try { DATA.classify('^VIX'); } catch (e) { return e instanceof DATA.NotFound; } })());
}

/* ═══ 2. Structural integrity ════════════════════════════════════════ */
section('2. Structural integrity across symbols and timeframes');
const CASES = [['AAPL', '1d'], ['AAPL', '1h'], ['AAPL', '5m'], ['AAPL', '4h'],
               ['MSFT', '15m'], ['SPY', '1d'], ['NVDA', '30m'], ['TSLA', '1wk'], ['BTC/USD', '1h']];
const got = {};
for (const [sym, tf] of CASES) {
  let r;
  try { r = await DATA.fetchBars(sym, tf); }
  catch (e) { ok(`${sym} ${tf}: fetch`, false, e.message); continue; }
  got[`${sym}|${tf}`] = r;
  const b = r.bars, tag = `${sym} ${tf}`;
  ok(`${tag}: returns bars`, b.length > 20, `${b.length}`);
  ok(`${tag}: time strictly increasing`, b.every((x, i) => !i || x.time > b[i - 1].time));
  ok(`${tag}: no duplicate stamps`, new Set(b.map(x => x.time)).size === b.length);
  ok(`${tag}: high >= max(open, close)`, b.every(x => x.high >= Math.max(x.open, x.close) - 1e-9));
  ok(`${tag}: low <= min(open, close)`, b.every(x => x.low <= Math.min(x.open, x.close) + 1e-9));
  ok(`${tag}: prices positive`, b.every(x => x.open > 0 && x.high > 0 && x.low > 0 && x.close > 0));
  ok(`${tag}: volume non-negative`, b.every(x => x.volume >= 0));
  ok(`${tag}: no NaN`, b.every(x => [x.time, x.utc, x.open, x.high, x.low, x.close, x.volume].every(Number.isFinite)));
  ok(`${tag}: keeps a true utc stamp`, b.every(x => Number.isFinite(x.utc)));
}

/* ═══ 3. Auction prints — the thing Yahoo got wrong ══════════════════ */
section('3. Auction prints present in the intraday series');
{
  const r = got['AAPL|5m'];
  if (r) {
    const byDay = new Map();
    for (const b of r.bars) {
      const k = dayOf(b);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(b);
    }
    const find = iso => {
      for (const [, bs] of byDay) {
        const d = new Date(bs[0].time * 1000).toISOString().slice(0, 10);
        if (d === iso) return bs;
      }
      return null;
    };
    const a4 = find('2026-08-04'), a7 = find('2026-08-07');
    if (a4) eq('AAPL 2026-08-04 opens at the official auction price', a4[0].open, 302.73, 0.01);
    else ok('AAPL 2026-08-04 present in the 5m window', false, 'outside lookback');
    if (a7) {
      eq('AAPL 2026-08-07 opens at the official auction price', a7[0].open, 311.45, 0.01);
      eq('AAPL 2026-08-07 closes at the official auction price', a7[a7.length - 1].close, 313.33, 0.02);
    }
    // A full regular session is exactly 78 five-minute bars.
    const full = [...byDay.values()].filter(bs => bs.length >= 70);
    ok('full sessions contain exactly 78 five-minute bars',
      full.length > 3 && full.every(bs => bs.length === 78),
      `counts: ${[...new Set(full.map(b => b.length))].join(',')}`);
  }
  // Daily bars must agree with the intraday session they summarise.
  const d = got['AAPL|1d'], f = got['AAPL|5m'];
  if (d && f) {
    const dmap = new Map(d.bars.map(b => [dayOf(b), b]));
    const groups = new Map();
    for (const b of f.bars) {
      const k = dayOf(b);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
    let checked = 0, openOk = 0, closeOk = 0, hiOk = 0, loOk = 0;
    for (const [k, bs] of groups) {
      const dd = dmap.get(k);
      if (!dd || bs.length < 70) continue;
      // the newest session may still be provisional (IEX tail)
      if (bs.some(x => x.provisional)) continue;
      checked++;
      if (Math.abs(bs[0].open - dd.open) < 0.02) openOk++;
      if (Math.abs(bs[bs.length - 1].close - dd.close) < 0.02) closeOk++;
      if (Math.abs(Math.max(...bs.map(x => x.high)) - dd.high) / dd.high < 0.001) hiOk++;
      if (Math.abs(Math.min(...bs.map(x => x.low)) - dd.low) / dd.low < 0.001) loOk++;
    }
    ok('5m sessions reproduce the daily open', checked > 5 && openOk === checked, `${openOk}/${checked}`);
    ok('5m sessions reproduce the daily close', checked > 5 && closeOk === checked, `${closeOk}/${checked}`);
    ok('5m sessions reproduce the daily high', checked > 5 && hiOk / checked > 0.9, `${hiOk}/${checked}`);
    ok('5m sessions reproduce the daily low', checked > 5 && loOk / checked > 0.9, `${loOk}/${checked}`);
  }
}

/* ═══ 4. Exchange-local time ═════════════════════════════════════════ */
section('4. Exchange-local timestamps');
{
  const h = got['AAPL|1h'];
  if (h) {
    // Alpaca's own hourly bars start at 09:00; these are rebuilt from 30Min
    // so they run 09:30→10:30 like every other platform.
    const bad = h.bars.filter(b => utcParts(b.time).m !== 30);
    ok('1h bars are anchored to the 09:30 session open', bad.length === 0, `${bad.length} off-grid`);
    const hours = new Set(h.bars.map(b => utcParts(b.time).h));
    ok('1h bars cover the session hours only',
      [...hours].every(x => x >= 9 && x <= 15), `hours: ${[...hours].sort((a, b) => a - b).join(',')}`);
    // A full session is 6 hourly bars: 09:30 through 15:30.
    const per = new Map();
    for (const b of h.bars) per.set(dayOf(b), (per.get(dayOf(b)) || 0) + 1);
    const counts = [...per.values()];
    ok('a full session yields 7 hourly bars (the last one short)',
      counts.filter(c => c === 7).length > counts.length * 0.8,
      `distribution: ${[...new Set(counts)].sort().join(',')}`);
  }
  // DST correctness is proven directly on the ten-year daily series below and
  // by the January/August session-window checks, rather than by hoping the
  // intraday lookback happens to straddle a transition.
  {
    const d = got['AAPL|1d'];
    if (d) {
      const summer = d.bars.filter(b => new Date(b.time * 1000).toISOString().slice(5, 7) === '07');
      const winter = d.bars.filter(b => new Date(b.time * 1000).toISOString().slice(5, 7) === '01');
      ok('daily bars sit at exchange midnight in summer (EDT)',
        summer.length > 50 && summer.every(b => utcParts(b.time).h === 0));
      ok('daily bars sit at exchange midnight in winter (EST)',
        winter.length > 50 && winter.every(b => utcParts(b.time).h === 0));
    }
  }
  const f = got['AAPL|5m'];
  if (f) {
    const first = new Map();
    for (const b of f.bars) { const k = dayOf(b); if (!first.has(k)) first.set(k, b); }
    const opens = [...first.values()].map(b => utcParts(b.time));
    ok('every session starts at 09:30 exchange-local',
      opens.every(p => p.h === 9 && p.m === 30), JSON.stringify(opens.slice(0, 3)));
  }
  const c1 = got['BTC/USD|1h'];
  if (c1) {
    ok('crypto is flagged 24h', c1.meta.is24h === true);
    ok('crypto is not shifted (UTC)', c1.meta.timezone === 'UTC');
    ok('crypto 1h bars sit on the hour', c1.bars.every(b => utcParts(b.time).m === 0));
  }
  const d = got['AAPL|1d'];
  if (d) ok('daily bars sit at exchange midnight', d.bars.every(b => utcParts(b.time).h === 0 && utcParts(b.time).m === 0));
}

/* ═══ 5. Session grid, half-days, extended hours ═════════════════════ */
section('5. Session grid and the market calendar');
{
  const cal = await DATA.calendar();
  ok('calendar loaded', cal.size > 500, `${cal.size} dates`);
  const thanksgivingFri = cal.get('2026-11-27');
  ok('calendar knows half-days', thanksgivingFri && thanksgivingFri.closeMin === 13 * 60,
    thanksgivingFri ? String(thanksgivingFri.closeMin) : 'missing');
  const normal = cal.get('2026-11-25');
  ok('normal days close at 16:00', normal && normal.closeMin === 16 * 60);
  ok('calendar carries extended-hours bounds', normal && normal.sessionOpenMin === 240 && normal.sessionCloseMin === 1200);

  const w = await DATA.sessionWindow(Math.floor(new Date('2026-08-07T18:00:00Z').getTime() / 1000));
  ok('session window resolves a date', w && w.date === '2026-08-07', w?.date);
  ok('session opens at 13:30 UTC in August (EDT)', w && new Date(w.open * 1000).toISOString().slice(11, 16) === '13:30',
    w ? new Date(w.open * 1000).toISOString() : '');
  ok('session closes at 20:00 UTC in August', w && new Date(w.close * 1000).toISOString().slice(11, 16) === '20:00');
  // Winter date: EST, so the same local times land an hour later in UTC.
  const wWinter = await DATA.sessionWindow(Math.floor(new Date('2026-01-15T18:00:00Z').getTime() / 1000));
  ok('DST is handled: January opens at 14:30 UTC (EST)',
    wWinter && new Date(wWinter.open * 1000).toISOString().slice(11, 16) === '14:30',
    wWinter ? new Date(wWinter.open * 1000).toISOString() : 'no window');

  // Regular-session filtering must drop pre/post bars by default.
  const reg = got['AAPL|5m'];
  if (reg) {
    const mins = reg.bars.map(b => utcParts(b.time).h * 60 + utcParts(b.time).m);
    ok('no pre-market bars by default', mins.every(m => m >= 9 * 60 + 30));
    ok('no after-hours bars by default', mins.every(m => m < 16 * 60));
  }
  const ext = await DATA.fetchBars('AAPL', '5m', { prePost: true });
  const emins = ext.bars.map(b => utcParts(b.time).h * 60 + utcParts(b.time).m);
  ok('extended hours adds pre-market bars', Math.min(...emins) < 9 * 60 + 30, `earliest ${Math.min(...emins)}`);
  ok('extended hours adds after-hours bars', Math.max(...emins) >= 16 * 60);
  ok('extended hours stays inside 04:00-20:00',
    Math.min(...emins) >= 4 * 60 && Math.max(...emins) < 20 * 60);
}

/* ═══ 6. SIP / IEX split ═════════════════════════════════════════════ */
section('6. Authoritative history with a real-time tail');
{
  const r = got['AAPL|5m'];
  ok('feed is reported', r?.meta.feed === 'sip + iex tail', r?.meta.feed);
  ok('provisional bars are counted', typeof r?.meta.provisionalCount === 'number', String(r?.meta.provisionalCount));
  const prov = r.bars.filter(b => b.provisional);
  ok('only the tail is provisional', prov.length < 12, `${prov.length} provisional`);
  if (prov.length) {
    const firstProv = r.bars.findIndex(b => b.provisional);
    ok('provisional bars are contiguous at the end',
      r.bars.slice(firstProv).every(b => b.provisional));
    ok('provisionalFrom marks the boundary', r.meta.provisionalFrom === r.bars[firstProv].time);
  }
  // Turning the live tail off must leave only authoritative data.
  const histOnly = await DATA.fetchBars('AAPL', '5m', { live: false });
  ok('live:false yields no provisional bars', histOnly.bars.every(b => !b.provisional));
}

/* ═══ 7. Corporate actions ═══════════════════════════════════════════ */
section('7. Corporate actions');
{
  // AAPL 4:1 split on 2020-08-31; split-adjusted close for 2020-08-25 is ~124.8.
  const split = await DATA.fetchBars('AAPL', '1d', {});
  const bar = split.bars.find(b => new Date(b.time * 1000).toISOString().slice(0, 10) === '2020-08-25');
  if (bar) {
    ok('history is split-adjusted by default', Math.abs(bar.close - 124.83) < 0.5, `${bar.close}`);
    let maxJump = 0;
    const around = split.bars.filter(b => {
      const d = new Date(b.time * 1000).toISOString().slice(0, 10);
      return d >= '2020-08-20' && d <= '2020-09-08';
    });
    for (let i = 1; i < around.length; i++)
      maxJump = Math.max(maxJump, Math.abs(around[i].close / around[i - 1].close - 1));
    ok('no split cliff in the series', maxJump < 0.15, `${(maxJump * 100).toFixed(1)}%`);
  } else ok('2020 history available for the split test', false, 'bar not found');

  const div = await DATA.fetchBars('KO', '1d', { dividendAdjusted: true });
  const plain = await DATA.fetchBars('KO', '1d', {});
  const oldDiv = div.bars[0], oldPlain = plain.bars.find(b => b.time === oldDiv.time);
  ok('dividend adjustment lowers older closes', oldPlain && oldDiv.close < oldPlain.close,
    `${oldDiv?.close} vs ${oldPlain?.close}`);
  ok('dividend adjustment leaves the latest bar alone',
    Math.abs(div.bars[div.bars.length - 1].close - plain.bars[plain.bars.length - 1].close) < 0.02);
}

/* ═══ 8. Live tick handling ══════════════════════════════════════════ */
section('8. Live tick handling');
{
  const open = Math.floor(new Date('2026-08-07T13:30:00Z').getTime() / 1000);
  const close = Math.floor(new Date('2026-08-07T20:00:00Z').getTime() / 1000);
  const meta = () => ({ tfSecs: 60, timezone: 'America/New_York', is24h: false, sessionStart: open, sessionEnd: close });
  const mk = (t0, n, secs) => Array.from({ length: n }, (_, i) => {
    const utc = t0 + i * secs;
    return { time: utc + DATA.tzOffset(utc, 'America/New_York'), utc, open: 100, high: 101, low: 99, close: 100, volume: 10 };
  });

  let bars = mk(open, 5, 60);
  ok('closed market: no tick applied', DATA.applyTick(bars, meta(), 123, close + 3600) === null);
  ok('closed market: no bar appended', bars.length === 5);

  bars = mk(open, 5, 60);
  let last = bars[4];
  let res = DATA.applyTick(bars, meta(), 105, last.utc + 30);
  ok('same bucket extends in place', res && !res.isNew && last.close === 105 && last.high === 105);
  DATA.applyTick(bars, meta(), 95, last.utc + 40);
  ok('low ratchets down', last.low === 95);

  bars = mk(open, 5, 60);
  res = DATA.applyTick(bars, meta(), 110, bars[4].utc + 65);
  ok('a new bucket appends exactly one bar', res && res.isNew && bars.length === 6);
  ok('the new bar is marked provisional', bars[5].provisional === true);
  ok('the new bar sits on the grid', (bars[5].time - bars[0].time) % 60 === 0);

  bars = mk(close - 120, 2, 60);
  DATA.applyTick(bars, meta(), 110, close - 1);
  ok('a bucket past the close is not opened', bars.length === 2);

  const cryptoMeta = { tfSecs: 3600, timezone: 'UTC', is24h: true, sessionStart: null, sessionEnd: null };
  ok('crypto is always open', DATA.marketOpen(cryptoMeta, 0) === true);
  const cb = mk(1786100000, 3, 3600);
  ok('crypto ticks apply at any hour', DATA.applyTick(cb, cryptoMeta, 150, cb[2].utc + 10) !== null);

  const dailyMeta = { ...meta(), tfSecs: 86400 };
  const db = [{ time: open + DATA.tzOffset(open, 'America/New_York'), utc: open, open: 100, high: 101, low: 99, close: 100, volume: 1 }];
  ok('daily bar updates during its session',
    DATA.applyTick(db, dailyMeta, 108, open + 3600)?.isNew === false && db[0].close === 108);
  ok('daily bar does not roll on its own',
    DATA.applyTick(db, dailyMeta, 108, open + 86400 * 2) === null && db.length === 1);
}

/* ═══ 9. Quotes, search, errors ══════════════════════════════════════ */
section('9. Quotes, search and error handling');
{
  const qs = await DATA.fetchQuotes(['AAPL', 'MSFT', 'NVDA', 'BTC/USD']);
  ok('batch quotes return every requested symbol', qs.length === 4, `${qs.length}: ${qs.map(q => q.symbol)}`);
  ok('batch quotes keep request order', qs[0].symbol === 'AAPL' && qs[2].symbol === 'NVDA');
  const a = qs.find(q => q.symbol === 'AAPL');
  ok('quote has a price', a.price > 0);
  ok('quote has a previous close', a.previousClose > 0);
  ok('change matches price - previousClose', Math.abs(a.change - (a.price - a.previousClose)) < 1e-6);
  ok('percent matches change / previousClose', Math.abs(a.changePct - a.change / a.previousClose * 100) < 1e-6);
  ok('crypto quote resolves', qs.find(q => q.symbol === 'BTC/USD')?.price > 0);
  // Volume must be consolidated, not the single-venue IEX figure. NVDA trades
  // ~100M shares a day; IEX alone reports ~4M, so a low number here means the
  // scanner would be ranking on 4% of the tape.
  const nv = (await DATA.fetchQuotes(['NVDA']))[0];
  ok('quote volume is consolidated, not IEX-only', nv.volume > 20e6,
    `${(nv.volume / 1e6).toFixed(2)}M`);
  ok('quote carries the session OHLC', nv.open > 0 && nv.dayHigh >= nv.dayLow);
  ok('day high bounds the close', nv.close == null || nv.dayHigh >= nv.close - 1e-9);
  ok('unresolvable symbols are dropped, not faked',
    (await DATA.fetchQuotes(['AAPL', 'ZZZZNOTREAL'])).length === 1);

  const hits = await DATA.search('AAPL');
  ok('search finds AAPL', hits.some(h => h.symbol === 'AAPL'), hits.map(h => h.symbol).join(','));
  ok('search ranks exact prefix first', hits[0].symbol.startsWith('AAPL'), hits[0]?.symbol);
  const btc = await DATA.search('BTC');
  ok('search surfaces crypto pairs', btc.some(h => h.symbol === 'BTC/USD'));
  ok('search caps its result count', (await DATA.search('A')).length <= 12);

  let threw = null;
  try { await DATA.fetchBars('ZZZZNOTREAL', '1d'); } catch (e) { threw = e; }
  ok('unknown symbol raises NotFound', threw instanceof DATA.NotFound, threw?.message);

  const saved = { key: c.key, secret: c.secret };
  DATA.setCreds('bogus', 'bogus', true);
  let authErr = null;
  try { await DATA.fetchQuotes(['AAPL']); } catch (e) { authErr = e; }
  ok('bad credentials raise AuthError', authErr instanceof DATA.AuthError, authErr?.message);
  DATA.setCreds(saved.key, saved.secret, c.paper);
  ok('credentials restore cleanly', DATA.hasCreds());
}

/* ═══ Summary ════════════════════════════════════════════════════════ */
console.log(`\n${'─'.repeat(64)}`);
if (fail) {
  console.log(`\x1b[31m${fail} FAILED\x1b[0m, ${pass} passed`);
  failures.forEach(f => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  process.exit(1);
} else {
  console.log(`\x1b[32mAll ${pass} checks passed against live Alpaca data\x1b[0m`);
}
