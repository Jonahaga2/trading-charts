/* ═══════════════════════════════════════════════════════════════════════
   UNIVERSE — the "common stocks only, float under 1bn" screen
   ───────────────────────────────────────────────────────────────────────
   Neither of those facts is in a price feed, so they come from a reference
   file:

     symbol,date,type,float
     ABCD,2019-01-01,CS,42000000
     ABCD,2019-06-14,CS,81000000        <- a raise doubled the float
     WXYZ,2019-01-01,ETF,

   `date` is the day the row became true. A lookup for some bar takes the
   most recent row dated on or before that bar — which is the whole point
   of the file.

   Why point-in-time, and not just today's float: a stock trading between
   $1 and $5 is very often a company issuing stock to stay alive. Its float
   in 2019 is not its float now, and screening 2019 bars on today's number
   means the screen knows about dilution that had not happened yet. It
   quietly removes the companies that diluted most — which is to say the
   ones that went on to do worst — and the backtest returns a number the
   strategy could never have earned. The same argument applies to `type`:
   a name that is a common stock today may have been a unit or an SPAC
   share then.

   A bar with no row on or before it is EXCLUDED by default. That will feel
   aggressive, and it is deliberate: "no data" is not evidence the screen
   passed, and treating it as a pass is the same lookahead by another
   route. Pass `onMissing: 'include'` if you would rather see everything
   and discount the result yourself.

   The deeper problem this file cannot fix is survivorship. If the symbols
   you feed the backtester are the ones you can download today, every
   company that was delisted, acquired, or went to zero is already missing,
   and no float column repairs that. A $1–5 universe is precisely where
   that bias is largest. Assemble the symbol list from a historical
   snapshot, delisted names included, or read the result as an upper bound
   rather than an estimate.
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';

const COMMON = new Set(['cs', 'common', 'commonstock', 'common stock', 'stock', 'share', 'shares']);

const parseDate = s => {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? `${s.trim()}T00:00:00Z` : s.trim());
  if (Number.isNaN(t)) throw new Error(`universe: unparseable date "${s}"`);
  return Math.floor(t / 1000);
};

export function parseUniverse(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[\s_]/g, ''));
  const iS = head.indexOf('symbol');
  const iD = head.indexOf('date');
  const iT = head.findIndex(h => h === 'type' || h === 'securitytype');
  const iF = head.findIndex(h => h === 'float' || h === 'sharesfloat' || h === 'freefloat');
  if (iS < 0 || iD < 0) throw new Error('universe: needs at least symbol and date columns');

  const bySymbol = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const sym = f[iS].trim().toUpperCase();
    if (!sym) continue;
    const row = {
      from: parseDate(f[iD]),
      type: iT >= 0 ? (f[iT] ?? '').trim().toLowerCase() : null,
      float: iF >= 0 && f[iF] != null && f[iF].trim() !== '' ? +f[iF] : null,
    };
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym).push(row);
  }
  for (const rows of bySymbol.values()) rows.sort((a, b) => a.from - b.from);
  return bySymbol;
}

/* The row in force on `at`, or null if the file says nothing yet. */
export function rowAt(rows, at) {
  if (!rows || !rows.length) return null;
  let lo = 0, hi = rows.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].from <= at) { found = rows[mid]; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

export function makeScreen(bySymbol, symbol, {
  maxFloat = 1e9, requireCommon = true, onMissing = 'exclude',
} = {}) {
  const rows = bySymbol.get((symbol || '').toUpperCase()) || null;
  const seen = { checked: 0, missing: 0, notCommon: 0, tooBig: 0, passed: 0 };
  const screen = at => {
    seen.checked++;
    const row = rowAt(rows, at);
    if (!row) { seen.missing++; return onMissing === 'include'; }
    if (requireCommon && row.type != null && !COMMON.has(row.type)) { seen.notCommon++; return false; }
    if (requireCommon && row.type == null) { seen.missing++; return onMissing === 'include'; }
    if (maxFloat != null) {
      if (row.float == null) { seen.missing++; return onMissing === 'include'; }
      if (!(row.float < maxFloat)) { seen.tooBig++; return false; }
    }
    seen.passed++;
    return true;
  };
  screen.stats = seen;
  return screen;
}

export function loadUniverse(file, symbol, opts) {
  return makeScreen(parseUniverse(fs.readFileSync(file, 'utf8')), symbol, opts);
}
