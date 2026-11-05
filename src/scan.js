/* ═══════════════════════════════════════════════════════════════════════
   SCAN — "big drop, then a recovery" over daily bars
   ───────────────────────────────────────────────────────────────────────
   Shared by the page (inlined into index.html, exposed as window.SCAN) and
   by scanner/run.mjs (required from Node), so the numbers the nightly job
   pre-filters on are computed by exactly the code the panel filters with.

   The definitions, for a window of the last `lookback` daily bars:

   • Peak and trough are the pair with the largest drawdown in the window:
     the trough is the lowest low *after* the peak, and the peak is the high
     that makes that fall deepest. Picking "the highest high, then the lowest
     low after it" instead misses a stock that crashed early in the window and
     never got back to its old high — exactly the stocks this is looking for.

   • drop      = (peak − trough) / peak               — how far it fell
   • retrace   = (close − trough) / (peak − trough)   — how much of that fall
                                                        it has since won back
     So a fall from $100 to $50 that is back to $60 has retraced 20%; a fall
     from $100 to $90 back to $92 has also retraced 20%.

   • fresh     = yesterday's close had not yet retraced `minRetrace`, today's
     has — the day the signal first appears.

   A drawdown in a shorter window can never be deeper than in the whole
   series, which is what makes pre-filtering on the full window sound.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* Largest peak-to-trough fall over bars [from, to). High and low arrays,
     same length. Returns null only for a window under two bars; a series
     that never fell comes back as drop 0.

     Each bar is measured against the peak *before* it and only then allowed
     to become the peak, so a bar is never its own trough — otherwise one
     wide day's range would count as a "drop". Ties go to the latest high,
     so a double top dates the fall from its second peak. */
  function maxDrawdown(h, l, from = 0, to = h.length) {
    from = Math.max(0, from);
    if (to - from < 2) return null;
    let peakI = from, peak = h[from];
    let best = { drop: 0, peakI: from, troughI: from };
    for (let i = from + 1; i < to; i++) {
      if (peak > 0) {
        const d = (peak - l[i]) / peak;
        if (d > best.drop) best = { drop: d, peakI, troughI: i };
      }
      if (h[i] >= peak) { peak = h[i]; peakI = i; }
    }
    return best;
  }

  const DEFAULTS = {
    lookback: 63,        // trading days the drop must fall inside (~3 months)
    minDrop: 30,         // %
    minRetrace: 20,      // % of the drop won back
    maxRetrace: 100,     // %
    minPrice: 1,         // $
    minDollarVol: 1e6,   // average daily $ volume
  };

  /* One symbol against one set of criteria. `row` is { h, l, c, dv } —
     daily highs, lows, closes (oldest first) and average daily dollar
     volume. Returns the measurements whether or not they pass, with `pass`. */
  function evaluate(row, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const n = row.c.length;
    if (n < 3) return null;
    const from = Math.max(0, n - o.lookback);
    const dd = maxDrawdown(row.h, row.l, from, n);
    if (!dd) return null;

    const peak = row.h[dd.peakI], trough = row.l[dd.troughI];
    const range = peak - trough;
    const close = row.c[n - 1];
    const retrace = range > 0 ? (close - trough) / range : 0;
    // Yesterday only counts as "not yet" if the trough was already in.
    const prev = dd.troughI <= n - 2 && range > 0 ? (row.c[n - 2] - trough) / range : -Infinity;
    const minR = o.minRetrace / 100;

    const m = {
      drop: dd.drop * 100,
      retrace: retrace * 100,
      peak, trough, close,
      dropDays: dd.troughI - dd.peakI,       // bars from the peak to the low
      sinceLow: n - 1 - dd.troughI,          // bars since the low
      fresh: prev < minR && retrace >= minR,
      dv: row.dv || 0,
    };
    m.pass = m.drop >= o.minDrop
      && m.retrace >= o.minRetrace
      && m.retrace <= o.maxRetrace
      && close >= o.minPrice
      && m.dv >= o.minDollarVol;
    return m;
  }

  /* Average daily dollar volume over the last `days` bars. */
  function dollarVolume(c, v, days = 20) {
    const n = Math.min(c.length, v.length);
    let sum = 0, k = 0;
    for (let i = Math.max(0, n - days); i < n; i++) {
      if (c[i] > 0 && v[i] >= 0) { sum += c[i] * v[i]; k++; }
    }
    return k ? sum / k : 0;
  }

  const api = { maxDrawdown, evaluate, dollarVolume, DEFAULTS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SCAN = api;
})(typeof window !== 'undefined' ? window : globalThis);
