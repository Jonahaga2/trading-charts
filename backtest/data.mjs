/* ═══════════════════════════════════════════════════════════════════════
   DATA — bars in, from wherever you have them
   ───────────────────────────────────────────────────────────────────────
   Two sources, one bar shape:

     { time, open, high, low, close, volume }     time = epoch seconds

   which is exactly what archive/lightweight-engine/ta.js already eats, so
   all 41 indicators work on either source without a shim.

     loadCsv()     — any OHLCV file. Column names are matched loosely
                     (Date/Timestamp/t, Close/close/c, …) because every
                     vendor spells them differently.
     loadAlpaca()  — the proven adapter in archive/lightweight-engine.
                     Needs credentials AND `data.alpaca.markets` allowed by
                     the egress policy; as of this writing the host answers
                     403 at CONNECT, so this path is wired but untested
                     from inside this container.

   On adjustment: if a file carries an `Adj Close`, loadCsv back-adjusts
   OHLC by the ratio adj/close. Skipping that step means a 2:1 split reads
   as a 50% overnight crash, and every momentum rule you test will "learn"
   to trade the split. Volume is left raw — splits and dividends cannot be
   told apart from the adjusted close alone, and guessing would corrupt the
   volume series on ordinary dividend dates to fix a handful of split days.

   The unadjusted prices survive on `bar.raw`, and any rule that filters on
   a price LEVEL must use them. A stock that changed hands at $0.40 before
   a 1-for-10 reverse split appears at $4.00 in the adjusted series, so a
   "$1 to $5" screen run against adjusted prices selects a different set of
   companies than the one you meant — and systematically favours the ones
   that later reverse-split, which is to say the ones that were failing.
   Returns come from the adjusted series; levels come from `raw`.
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const pick = (head, ...names) => {
  for (const n of names) {
    const i = head.findIndex(h => h.toLowerCase().replace(/[\s_]/g, '') === n);
    if (i >= 0) return i;
  }
  return -1;
};

function parseTime(raw) {
  const s = String(raw).trim();
  if (/^\d{9,10}$/.test(s)) return parseInt(s, 10);              // epoch seconds
  if (/^\d{12,13}$/.test(s)) return Math.floor(parseInt(s, 10) / 1000);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) throw new Error(`unparseable date: ${raw}`);
  return Math.floor(t / 1000);
}

export function loadCsv(file, { adjust = true } = {}) {
  const text = fs.readFileSync(file, 'utf8').trim();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error(`${file}: no data rows`);

  const head = lines[0].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  const iT = pick(head, 'date', 'time', 'timestamp', 't', 'datetime');
  const iO = pick(head, 'open', 'o');
  const iH = pick(head, 'high', 'h');
  const iL = pick(head, 'low', 'l');
  const iC = pick(head, 'close', 'c');
  const iV = pick(head, 'volume', 'v', 'vol');
  const iA = pick(head, 'adjclose', 'adjustedclose', 'adj');

  for (const [name, i] of [['date', iT], ['open', iO], ['high', iH], ['low', iL], ['close', iC]]) {
    if (i < 0) throw new Error(`${file}: no ${name} column in [${head.join(', ')}]`);
  }

  const bars = [];
  for (let r = 1; r < lines.length; r++) {
    const f = lines[r].split(',');
    const o = +f[iO], h = +f[iH], l = +f[iL], c = +f[iC];
    if (![o, h, l, c].every(Number.isFinite)) continue;           // holiday/blank rows
    let bar = {
      time: parseTime(f[iT]),
      open: o, high: h, low: l, close: c,
      volume: iV >= 0 ? (+f[iV] || 0) : 0,
    };
    if (adjust && iA >= 0 && Number.isFinite(+f[iA]) && c !== 0) {
      const k = +f[iA] / c;
      bar = {
        ...bar, open: o * k, high: h * k, low: l * k, close: c * k,
        adjusted: true, raw: { open: o, high: h, low: l, close: c },
      };
    }
    bars.push(bar);
  }

  bars.sort((a, b) => a.time - b.time);
  const clean = bars.filter((b, i) => i === 0 || b.time !== bars[i - 1].time);
  if (!clean.length) throw new Error(`${file}: parsed 0 usable bars`);
  return clean;
}

/* Credentials, in the order the archived test looks for them. Env vars win
   so the container can carry them without a file on disk. */
export function alpacaCreds() {
  const direct = {
    key: process.env.APCA_API_KEY_ID || process.env.ALPACA_KEY_ID,
    secret: process.env.APCA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY,
  };
  if (direct.key && direct.secret) return { ...direct, paper: /^PK/.test(direct.key) };

  const files = [
    process.env.ALPACA_ENV,
    path.join(os.homedir(), 'trading-dashboard', '.env'),
    path.join(ROOT, '.env'),
  ].filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const env = Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    const key = env.APCA_API_KEY_ID || env.ALPACA_KEY_ID;
    const secret = env.APCA_API_SECRET_KEY || env.ALPACA_SECRET_KEY;
    if (key && secret) return { key, secret, paper: /^PK/.test(key) };
  }
  return null;
}

export async function loadAlpaca(symbol, timeframe = '1D', opts = {}) {
  const creds = alpacaCreds();
  if (!creds) {
    throw new Error(
      'No Alpaca credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY in the '
      + 'environment, or point ALPACA_ENV at a .env holding them.');
  }
  const require = createRequire(import.meta.url);
  const DATA = require(path.join(ROOT, 'archive', 'lightweight-engine', 'data.js'));
  DATA.setCreds(creds.key, creds.secret, creds.paper);

  const { bars } = await DATA.fetchBars(symbol, timeframe, opts);
  if (!bars || !bars.length) throw new Error(`Alpaca returned no bars for ${symbol}`);
  /* Provisional bars are the real-time IEX tail, not consolidated SIP. They
     are fine to look at and wrong to backtest on. */
  return bars.filter(b => !b.provisional);
}

export function slice(bars, from, to) {
  const lo = from ? parseTime(from) : -Infinity;
  const hi = to ? parseTime(to) : Infinity;
  return bars.filter(b => b.time >= lo && b.time <= hi);
}

export function describe(bars) {
  const d = t => new Date(t * 1000).toISOString().slice(0, 10);
  return `${bars.length} bars, ${d(bars[0].time)} → ${d(bars[bars.length - 1].time)}`
    + (bars[0].adjusted ? ' (back-adjusted)' : '');
}
