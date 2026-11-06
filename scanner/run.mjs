/* ═══════════════════════════════════════════════════════════════════════
   Nightly dip scan — every US-listed common stock, from Yahoo daily bars
   ───────────────────────────────────────────────────────────────────────
   Run on a server, not in the page. Yahoo sends no CORS header, so a hosted
   page can only reach it through a third-party proxy, and pushing ~6,000
   chart requests through one of those is a guaranteed 429 (see the commit
   that retired the Yahoo adapter, 5d73b8e). From Node it is a direct call.

   Universe: Nasdaq Trader's symbol directory — nasdaqlisted.txt plus
   otherlisted.txt (NYSE, NYSE American, NYSE Arca, Cboe, IEX). ETFs, test
   issues, warrants, rights, units, preferreds and notes are dropped.

   Output: a compact JSON of every stock that fell at least PREFILTER.minDrop
   inside the stored window, with its daily highs, lows and closes, so the
   panel can re-run the scan with any thresholds at or above the prefilter
   without another network call.

     node scanner/run.mjs                       full scan → .scan/scan.json
     node scanner/run.mjs --symbols AAPL,TSLA   just these
     node scanner/run.mjs --limit 200           first 200 of the universe
     node scanner/run.mjs --out path.json --drop 40 --retrace 20 --lookback 90
   ═══════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SCAN = require('../src/scan.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BARS = 126;                 // ~6 months of sessions: the longest lookback offered
export const PREFILTER = { minDrop: 20, minPrice: 1, minDollarVol: 1e6 };

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DIR = 'https://www.nasdaqtrader.com/dynamic/SymDir/';
const YF_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

// Nasdaq Trader exchange codes → the prefix TradingView files them under.
// TradingView lists NYSE Arca and NYSE American both as AMEX.
const EXCH = { N: 'NYSE', A: 'AMEX', P: 'AMEX', Z: 'CBOE', V: 'IEX' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Universe ─────────────────────────────────────────────────────── */
const NOT_COMMON = /\b(warrants?|rights?|units?|preferred|depositary shares? representing|notes? due|debentures?|subordinated|perpetual|% )/i;

/* "Alphabet Inc. - Class A Common Stock" → "Alphabet Inc. Class A" */
export function cleanName(s) {
  let n = String(s || '').split(' - ')[0];
  const cls = /\bClass [A-Z]\b/.exec(n)?.[0];
  n = n.replace(/\s+(Class [A-Z]\s+)?(Common Stock|Ordinary Shares|Common Shares|Common Units|Shares of Beneficial Interest)\b.*$/i, '').trim();
  const full = String(s || '');
  const tail = !cls && / - /.test(full) ? /\bClass [A-Z]\b/.exec(full)?.[0] : null;
  return [n, cls && !n.includes(cls) ? cls : tail].filter(Boolean).join(' ');
}

/* Pipe-delimited, header first, a "File Creation Time" trailer last. */
function parsePipes(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split('|');
  return lines
    .filter(l => !l.startsWith('File Creation Time'))
    .map(l => Object.fromEntries(l.split('|').map((v, i) => [head[i], v])));
}

export function parseUniverse(nasdaqText, otherText) {
  const out = new Map();
  const add = (sym, exch, name) => {
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(sym)) return;     // drops $, =, ^ forms
    if (NOT_COMMON.test(name)) return;
    if (!out.has(sym)) out.set(sym, { s: sym, x: exch, n: cleanName(name) });
  };
  for (const r of parsePipes(nasdaqText)) {
    if (r['Test Issue'] !== 'N' || r.ETF !== 'N') continue;
    add(r.Symbol, 'NASDAQ', r['Security Name']);
  }
  for (const r of parsePipes(otherText)) {
    if (r['Test Issue'] !== 'N' || r.ETF !== 'N') continue;
    const x = EXCH[r.Exchange];
    if (x) add(r['ACT Symbol'], x, r['Security Name']);
  }
  return [...out.values()];
}

/* ── Yahoo ────────────────────────────────────────────────────────── */
export const yahooSymbol = s => s.replace('.', '-');     // BRK.B → BRK-B

/* Daily chart → { h, l, c, v } with untraded (null) days removed. */
export function parseChart(json) {
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r || !q || !r.timestamp) return null;
  const h = [], l = [], c = [], v = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
    h.push(q.high[i]); l.push(q.low[i]); c.push(q.close[i]); v.push(q.volume?.[i] ?? 0);
  }
  return c.length ? { h, l, c, v, last: r.timestamp[r.timestamp.length - 1] } : null;
}

class NotFound extends Error {}
class HttpError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}
/* Thrown when the first stretch of a run is nearly all refusals: Yahoo is
   blocking this machine, and grinding through 6,000 retries cannot fix that.
   The first run did exactly that — an hour of 429s, then a timeout. */
export class Blocked extends Error {}

/* ── Yahoo session ──────────────────────────────────────────────────
   Yahoo refuses cookieless requests from data-centre addresses, which is
   every request from GitHub Actions. The same handshake yfinance uses gets
   a session: fc.yahoo.com sets the A3 cookie (it answers 404, but the cookie
   comes with it), then /v1/test/getcrumb turns the cookie into a crumb that
   rides along on every chart request. Without a crumb the scan still tries,
   since the chart endpoint sometimes answers anyway. */
export async function getSession(fetchFn = fetch) {
  let cookie = '', status = 0;
  try {
    const r = await fetchFn('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const set = r.headers?.getSetCookie?.() ?? [];
    cookie = set.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  } catch {}
  for (const host of YF_HOSTS) {
    try {
      const r = await fetchFn(`${host}/v1/test/getcrumb`, { headers: { 'User-Agent': UA, ...(cookie && { Cookie: cookie }) } });
      status = r.status;
      const t = (await r.text()).trim();
      // A real crumb is a short token; anything else is an error page.
      if (r.ok && t && t.length < 64 && !/[<\s{]/.test(t)) return { cookie, crumb: t, status };
    } catch { status = status || -1; }
  }
  return { cookie, crumb: '', status };
}

async function getChart(sym, ctx) {
  let lastErr, refreshed = false;
  for (let t = 0; t < ctx.tries; t++) {
    const used = ctx.session;
    const { cookie, crumb } = await used;
    const host = YF_HOSTS[t % YF_HOSTS.length];
    const url = `${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol(sym))}?range=6mo&interval=1d&includePrePost=false`
      + (crumb ? `&crumb=${encodeURIComponent(crumb)}` : '');
    try {
      const r = await ctx.fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(cookie && { Cookie: cookie }) } });
      if (r.status === 404) throw new NotFound(sym);
      if (r.ok) return parseChart(await r.json());
      lastErr = new HttpError(r.status);
      // An expired session answers 401: get a new one once, shared by every
      // worker, rather than each worker re-handshaking at the same moment.
      if (r.status === 401 && !refreshed) {
        refreshed = true;
        // Only if nobody has renewed it since this request set out.
        if (ctx.session === used) ctx.session = getSession(ctx.fetchFn);
        continue;
      }
      // 429 and 5xx are worth waiting out; anything else will not change.
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      if (e instanceof NotFound) throw e;
      lastErr = e;
    }
    if (t < ctx.tries - 1) await sleep(ctx.backoff * 2 ** t * (1 + Math.random() / 2));
  }
  throw lastErr;
}

/* Trim to the stored window and round, so the file stays small: cents for
   anything over a dollar, four places below it. */
const round = x => (x >= 1 ? Math.round(x * 100) / 100 : Math.round(x * 1e4) / 1e4);

/* `probe`: after this many symbols, a run where at least `blockedAt` of them
   failed is abandoned with Blocked, naming what Yahoo answered. */
export async function scan(universe, {
  fetchFn = fetch, concurrency = 6, backoff = 800, tries = 4, probe = 60, blockedAt = 0.9, session, onProgress,
} = {}) {
  const rows = [], failed = [];
  const errors = {};                       // final error per failed symbol: "HTTP 429" → count
  let done = 0, next = 0, asOf = 0, ok = 0, blocked = null;
  const sess = Promise.resolve(session || getSession(fetchFn));
  const ctx = { fetchFn, backoff, tries, session: sess };
  async function worker() {
    while (next < universe.length && !blocked) {
      const u = universe[next++];
      try {
        const bars = await getChart(u.s, ctx);
        ok++;
        if (bars) {
          asOf = Math.max(asOf, bars.last || 0);
          const dv = SCAN.dollarVolume(bars.c, bars.v);
          const k = Math.max(0, bars.c.length - BARS);
          const row = { ...u, dv: Math.round(dv), h: bars.h.slice(k).map(round), l: bars.l.slice(k).map(round), c: bars.c.slice(k).map(round) };
          const m = SCAN.evaluate(row, { lookback: BARS, minDrop: 0, minRetrace: 0, maxRetrace: 100, minPrice: 0, minDollarVol: 0 });
          if (m && m.drop >= PREFILTER.minDrop && m.close >= PREFILTER.minPrice && dv >= PREFILTER.minDollarVol) rows.push(row);
        }
      } catch (e) {
        if (e instanceof NotFound) ok++;
        else {
          failed.push(u.s);
          const k = e instanceof HttpError ? e.message : `network: ${e?.cause?.code || e?.message || e}`;
          errors[k] = (errors[k] || 0) + 1;
        }
      }
      done++;
      if (onProgress) onProgress(done, universe.length, rows.length, failed.length, errors);
      if (!blocked && done >= probe && universe.length > probe && failed.length >= done * blockedAt) {
        blocked = new Blocked(`Yahoo refused ${failed.length} of the first ${done} symbols — ${fmtErrors(errors)}. Stopping rather than retrying the rest.`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (blocked) { blocked.errors = errors; blocked.session = await ctx.session; throw blocked; }
  rows.sort((a, b) => a.s.localeCompare(b.s));
  return {
    v: 1,
    generated: new Date().toISOString(),
    asOf: asOf ? new Date(asOf * 1000).toISOString().slice(0, 10) : null,
    bars: BARS,
    prefilter: PREFILTER,
    universe: universe.length,
    failed: failed.length,
    errors,
    failedSymbols: failed.slice(0, 200),
    rows,
  };
}

export const fmtErrors = errors => Object.entries(errors).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ') || 'no errors';

/* ── CLI ──────────────────────────────────────────────────────────── */
function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w+)$/.exec(argv[i]);
    if (m) a[m[1]] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

async function getText(url) {
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return await r.text();
    } catch {}
    await sleep(1000 * 2 ** t);
  }
  throw new Error('could not fetch ' + url);
}

async function main() {
  const a = args(process.argv.slice(2));
  let universe;
  if (a.symbols) {
    universe = String(a.symbols).toUpperCase().split(/[\s,]+/).filter(Boolean).map(s => ({ s, x: '', n: '' }));
  } else {
    const [nq, other] = await Promise.all([getText(DIR + 'nasdaqlisted.txt'), getText(DIR + 'otherlisted.txt')]);
    universe = parseUniverse(nq, other);
    if (a.limit) universe = universe.slice(0, +a.limit);
  }
  console.error(`scanning ${universe.length} symbols…`);

  const t0 = Date.now();
  const tty = process.stderr.isTTY;
  const session = await getSession();
  console.error(`yahoo session: cookie ${session.cookie ? 'yes' : 'NO'}, crumb ${session.crumb ? 'yes' : 'NO'} (getcrumb answered ${session.status})`);

  let out;
  try {
    out = await scan(universe, {
      session,
      concurrency: +a.concurrency || 6,
      onProgress: (d, n, kept, bad, errors) => {
        // Early and often at first, so a blocked run says so in the log at once.
        if (tty ? d % 25 === 0 || d === n : d === 20 || d % 250 === 0 || d === n)
          process.stderr.write(`${tty ? '\r' : ''}${d}/${n}  kept ${kept}  failed ${bad}`
            + (bad ? `  (${fmtErrors(errors)})` : '') + (tty ? '' : '\n'));
      },
    });
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    console.error(`\n${e.message}`);
    process.exit(3);
  }
  if (tty) process.stderr.write('\n');

  const file = path.resolve(a.out || path.join(ROOT, '.scan', 'scan.json'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  console.error(`wrote ${file} — ${out.rows.length} stocks fell ≥${PREFILTER.minDrop}%, `
    + `${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${out.failed} failed (${fmtErrors(out.errors)}), ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // The same scan the panel opens with, printed.
  const opts = {
    lookback: +a.lookback || SCAN.DEFAULTS.lookback,
    minDrop: +a.drop || SCAN.DEFAULTS.minDrop,
    minRetrace: a.retrace != null ? +a.retrace : SCAN.DEFAULTS.minRetrace,
  };
  const hits = out.rows.map(r => ({ r, m: SCAN.evaluate(r, opts) })).filter(x => x.m?.pass)
    .sort((x, y) => y.m.drop - x.m.drop);
  console.log(`\n${hits.length} fell ≥${opts.minDrop}% within ${opts.lookback} days and retraced ≥${opts.minRetrace}% of it (as of ${out.asOf}):\n`);
  console.log('SYMBOL   CLOSE      DROP   RETRACE  LOW→NOW  NEW');
  for (const { r, m } of hits.slice(0, +a.top || 40)) {
    console.log(`${r.s.padEnd(8)} ${m.close.toFixed(2).padStart(8)}  ${m.drop.toFixed(1).padStart(5)}%  ${m.retrace.toFixed(1).padStart(6)}%  ${String(m.sinceLow + 'd').padStart(6)}   ${m.fresh ? '●' : ''}`);
  }

  // A run where Yahoo refused most requests is not a scan; fail loudly so the
  // workflow does not publish it over yesterday's good one.
  if (out.failed > universe.length * 0.25) {
    console.error(`\n${out.failed} of ${universe.length} requests failed — treating the run as failed`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
