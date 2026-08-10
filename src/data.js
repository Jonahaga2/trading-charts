/* ═══════════════════════════════════════════════════════════════════════
   DATA — Yahoo Finance adapter
   ───────────────────────────────────────────────────────────────────────
   Every rule here was checked against live Yahoo responses, not assumed.
   The findings that shaped it:

   • Daily bars are stamped 09:30 exchange-local, NOT UTC midnight. Bucketing
     live updates by UTC midnight (as the old build did) means the daily
     candle never updates at all.
   • Yahoo appends a synthetic trailing bar carrying the current price:
     volume 0, open==high==low==close, and often off the interval grid
     (BTC 1h returned a bar stamped 05:06:32). Rendering it produces a fake
     flat candle at the right edge of every intraday chart. It is a live
     tick, so it is merged into the forming bar instead.
   • OHLC from the chart endpoint is already split-adjusted; `adjclose` is
     additionally dividend-adjusted. Split adjustment is the default (this
     is what TradingView shows); dividends are opt-in.
   • Yahoo serves a native, session-anchored 4h interval. Resampling 1h bars
     into UTC 4h buckets — the old approach — straddles the session open.
   • interval=1d&range=max silently returns ~168 bars, not 25 years.
   • /v7/finance/quote returns 401 without a crumb; /v8/finance/spark does not.
   • Direct browser fetches to Yahoo have no CORS header, so a proxy is
     mandatory from a hosted page. corsproxy.io is Origin-gated: it works
     from a browser and 403s from a script.
   ═══════════════════════════════════════════════════════════════════════ */
const DATA = (() => {
  'use strict';

  const YF = 'https://query1.finance.yahoo.com';

  /* ── Timeframes ───────────────────────────────────────────────────────
     `range` is the largest window Yahoo actually serves for that interval;
     asking for more returns HTTP 422 rather than truncating. */
  const TIMEFRAMES = [
    { id: '1m',  label: '1m',  interval: '1m',  secs: 60,     range: '7d'   },
    { id: '2m',  label: '2m',  interval: '2m',  secs: 120,    range: '60d'  },
    { id: '5m',  label: '5m',  interval: '5m',  secs: 300,    range: '60d'  },
    { id: '15m', label: '15m', interval: '15m', secs: 900,    range: '60d'  },
    { id: '30m', label: '30m', interval: '30m', secs: 1800,   range: '60d'  },
    { id: '1h',  label: '1H',  interval: '1h',  secs: 3600,   range: '730d' },
    { id: '4h',  label: '4H',  interval: '4h',  secs: 14400,  range: '730d' },
    { id: '1d',  label: '1D',  interval: '1d',  secs: 86400,  range: '10y'  },
    { id: '1wk', label: '1W',  interval: '1wk', secs: 604800, range: '10y'  },
    { id: '1mo', label: '1M',  interval: '1mo', secs: 2592000, range: '10y' },
  ];
  const TF = Object.fromEntries(TIMEFRAMES.map(t => [t.id, t]));
  const isIntraday = tf => TF[tf] && TF[tf].secs < 86400;

  /* ── Exchange-timezone shifting ───────────────────────────────────────
     lightweight-charts draws whatever epoch it is handed as UTC. To show
     exchange time (what every other charting package shows) the bar stamps
     are shifted by the exchange's UTC offset *at that instant*, so DST
     boundaries land correctly — a single fixed meta.gmtoffset would put half
     the year an hour out.

     A pleasant side effect: once shifted, floor(t / 86400) is the
     exchange-local calendar day, which is exactly the key VWAP and pivots
     need to anchor a session. */
  const _fmtCache = new Map();
  function _formatter(tz) {
    let f = _fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      _fmtCache.set(tz, f);
    }
    return f;
  }
  const _offCache = new Map();
  // UTC offset, in seconds, of `tz` at the instant `utcSec`.
  function tzOffset(utcSec, tz) {
    if (!tz || tz === 'UTC') return 0;
    // Cached per exchange-day. US DST changes on a Sunday with markets shut,
    // so an intra-day transition never affects a real equity bar.
    const key = tz + ':' + Math.floor(utcSec / 86400);
    const hit = _offCache.get(key);
    if (hit !== undefined) return hit;
    const p = Object.fromEntries(_formatter(tz).formatToParts(new Date(utcSec * 1000))
      .filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
    const off = Math.round(asUtc - utcSec);
    _offCache.set(key, off);
    return off;
  }

  /* ── Network ──────────────────────────────────────────────────────────
     Ordered by measured reliability. corsproxy.io is first because it is
     both fastest and the only one that consistently answers; the others are
     genuine fallbacks, not decoration. A hosted page can never reach Yahoo
     directly, so there is no "try direct first" step to waste a timeout on.  */
  const PROXIES = [
    u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    u => `https://proxy.cors.sh/${u}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];

  let directFetch = false;              // node/tests can bypass the proxies
  const setDirect = v => { directFetch = v; };

  function withTimeout(url, ms) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // A 404 means the symbol does not exist — retrying or trying another proxy
  // cannot help, so fail immediately rather than burning three timeouts.
  class NotFound extends Error {}

  async function getJSON(url, timeout = 12000) {
    const attempts = directFetch ? [u => u] : PROXIES;
    let lastErr;
    // Yahoo and the proxies both rate limit; back off rather than giving up,
    // otherwise a six-wide scanner sweep trips 429 and reports "no data".
    for (let round = 0; round < 3; round++) {
      for (const make of attempts) {
        try {
          const r = await withTimeout(make(url), timeout);
          if (r.status === 404) throw new NotFound('symbol not found');
          if (r.status === 429 || r.status >= 500) { lastErr = new Error('HTTP ' + r.status); continue; }
          if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
          const text = await r.text();
          try { return JSON.parse(text); } catch { lastErr = new Error('malformed response'); }
        } catch (e) {
          if (e instanceof NotFound) throw e;
          lastErr = e;
        }
      }
      if (round < 2) await sleep(400 * Math.pow(3, round));   // 0.4s, 1.2s
    }
    throw lastErr || new Error('network unreachable');
  }

  /* ── Parsing ─────────────────────────────────────────────────────────── */

  // A bar is a stub if it carries no information: Yahoo's live-price marker.
  // Checked only on the final bar, where Yahoo puts it.
  const isStub = b =>
    (b.volume === 0 || b.volume == null) &&
    b.open === b.high && b.high === b.low && b.low === b.close;

  function parseChart(json, tfId, opts = {}) {
    const res = json?.chart?.result?.[0];
    if (!res) {
      const msg = json?.chart?.error?.description || 'no data';
      throw new Error(msg);
    }
    const meta = res.meta || {};
    const ts = res.timestamp || [];
    const q = res.indicators?.quote?.[0];
    if (!ts.length || !q) throw new Error('empty series');

    const tz = meta.exchangeTimezoneName || 'UTC';
    const adjClose = res.indicators?.adjclose?.[0]?.adjclose;
    const useDiv = !!opts.dividendAdjusted && Array.isArray(adjClose);

    const raw = [];
    for (let i = 0; i < ts.length; i++) {
      let o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      const v = q.volume?.[i];
      // Yahoo emits explicit nulls for holidays and untraded crypto minutes.
      if (o == null || h == null || l == null || c == null) continue;
      if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
      if (h < l) continue;
      // Dividend adjustment scales the whole bar by adjclose/close so the
      // candle body stays proportionally correct, not just the close.
      if (useDiv && adjClose[i] != null && c !== 0) {
        const k = adjClose[i] / c;
        o *= k; h *= k; l *= k; c *= k;
      }
      const utc = ts[i];
      raw.push({
        time: utc + tzOffset(utc, tz),   // exchange-local, for display + sessions
        utc,
        open: o,
        high: Math.max(h, o, c),         // Yahoo occasionally floats these by 1e-6
        low: Math.min(l, o, c),
        close: c,
        volume: v || 0,
      });
    }
    if (!raw.length) throw new Error('no valid candles');

    // De-duplicate and sort. The renderer requires strictly increasing time.
    raw.sort((a, b) => a.time - b.time);
    const bars = [];
    for (const b of raw) {
      if (bars.length && bars[bars.length - 1].time === b.time) bars[bars.length - 1] = b;
      else bars.push(b);
    }

    // Fold Yahoo's trailing live-price stub into the bar that is still forming.
    let livePrice = null;
    if (bars.length > 1 && isStub(bars[bars.length - 1])) {
      const stub = bars.pop();
      livePrice = stub.close;
      const last = bars[bars.length - 1];
      last.close = stub.close;
      last.high = Math.max(last.high, stub.close);
      last.low = Math.min(last.low, stub.close);
    }

    const period = meta.currentTradingPeriod?.regular;
    return {
      bars,
      meta: {
        symbol: meta.symbol,
        name: meta.shortName || meta.longName || meta.symbol,
        exchange: meta.fullExchangeName || meta.exchangeName || '',
        currency: meta.currency || 'USD',
        timezone: tz,
        instrumentType: meta.instrumentType || '',
        is24h: (meta.instrumentType === 'CRYPTOCURRENCY') || tz === 'UTC',
        price: meta.regularMarketPrice ?? livePrice ?? bars[bars.length - 1].close,
        previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
        dayHigh: meta.regularMarketDayHigh ?? null,
        dayLow: meta.regularMarketDayLow ?? null,
        volume: meta.regularMarketVolume ?? null,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
        priceHint: meta.priceHint ?? 2,
        sessionStart: period?.start ?? null,
        sessionEnd: period?.end ?? null,
        marketTime: meta.regularMarketTime ?? null,
        tfSecs: TF[tfId]?.secs ?? 86400,
      },
      livePrice,
    };
  }

  /* ── Public fetches ──────────────────────────────────────────────────── */

  function chartURL(symbol, tfId, opts = {}) {
    const tf = TF[tfId] || TF['1d'];
    const p = new URLSearchParams({
      interval: tf.interval,
      range: opts.range || tf.range,
      includePrePost: String(!!opts.prePost),
    });
    // Splits and dividends are needed to build the adjustment factor.
    p.set('events', 'div,split');
    return `${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?${p}`;
  }

  /* ── Auction reconciliation ───────────────────────────────────────────
     Yahoo serves intraday bars from a thinner feed than its daily bars, and
     that feed misses the opening and closing auction prints. Measured on
     AAPL/NVDA/TSLA: the daily open falls *outside* the range of the 09:30
     one-minute bar on roughly 5 sessions in 8 — on 2026-08-04 the official
     open was 302.73 while the first minute only traded 303.74–303.79.

     Every real charting platform puts the auction in the session's first and
     last candle, which is why an untouched Yahoo intraday chart visibly
     disagrees with TradingView on exactly those two bars. Both prints happen
     at known times, so they can be placed exactly: the open belongs to the
     session's first bar, the close to its last. Nothing else is inferred —
     the daily high/low are deliberately not redistributed, because there is
     no way to know which bar they belong to without fabricating.           */
  function reconcileAuctions(bars, dailyBars, tolerance = 0.05) {
    if (!bars.length || !dailyBars?.length) return 0;
    const daily = new Map(dailyBars.map(b => [Math.floor(b.time / DAY), b]));
    const first = new Map(), last = new Map();
    for (const b of bars) {
      const k = Math.floor(b.time / DAY);
      if (!first.has(k)) first.set(k, b);
      last.set(k, b);
    }
    let patched = 0;
    for (const [k, d] of daily) {
      const f = first.get(k), l = last.get(k);
      if (!f || !l) continue;
      // Refuse to "correct" anything that looks like a different instrument
      // or a split-adjustment mismatch rather than an auction print.
      if (Math.abs(d.open - f.open) / f.open < tolerance) {
        if (d.open !== f.open) patched++;
        f.open = d.open;
        f.high = Math.max(f.high, d.open);
        f.low = Math.min(f.low, d.open);
      }
      if (Math.abs(d.close - l.close) / l.close < tolerance) {
        if (d.close !== l.close) patched++;
        l.close = d.close;
        l.high = Math.max(l.high, d.close);
        l.low = Math.min(l.low, d.close);
      }
    }
    return patched;
  }

  // Daily range wide enough to cover the intraday window being reconciled.
  const DAILY_COVER = { '1m': '1mo', '2m': '3mo', '5m': '3mo', '15m': '3mo', '30m': '3mo', '1h': '2y', '4h': '2y' };

  async function fetchBars(symbol, tfId, opts = {}) {
    const json = await getJSON(chartURL(symbol, tfId, opts), 14000);
    const parsed = parseChart(json, tfId, opts);

    // Only meaningful for regular-session intraday charts: the daily bar
    // describes regular hours, so it cannot reconcile an extended-hours
    // series, and daily-and-slower bars already contain the auctions.
    const wants = opts.reconcile !== false && isIntraday(tfId) && !opts.prePost && !parsed.meta.is24h;
    if (wants) {
      try {
        const dj = await getJSON(chartURL(symbol, '1d', {
          range: DAILY_COVER[tfId] || '3mo', dividendAdjusted: opts.dividendAdjusted,
        }), 10000);
        const dbars = parseChart(dj, '1d', opts).bars;
        parsed.meta.auctionsPatched = reconcileAuctions(parsed.bars, dbars);
      } catch { parsed.meta.auctionsPatched = null; }   // never fail the chart over this
    }
    return parsed;
  }

  // Light quote used by the poller and the scanner. One chart request with a
  // one-day range is ~1.2 KB and carries every field /v7/finance/quote used to.
  async function fetchQuote(symbol) {
    const json = await getJSON(`${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`, 9000);
    const m = json?.chart?.result?.[0]?.meta;
    if (!m || !(m.regularMarketPrice > 0)) throw new Error('no quote for ' + symbol);
    const prev = m.chartPreviousClose ?? m.previousClose ?? null;
    return {
      symbol: m.symbol,
      name: m.shortName || m.longName || m.symbol,
      price: m.regularMarketPrice,
      previousClose: prev,
      change: prev ? m.regularMarketPrice - prev : 0,
      changePct: prev ? (m.regularMarketPrice - prev) / prev * 100 : 0,
      volume: m.regularMarketVolume ?? 0,
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      fiftyTwoWeekHigh: m.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: m.fiftyTwoWeekLow ?? null,
      currency: m.currency || 'USD',
      timezone: m.exchangeTimezoneName || 'UTC',
      sessionStart: m.currentTradingPeriod?.regular?.start ?? null,
      sessionEnd: m.currentTradingPeriod?.regular?.end ?? null,
      marketTime: m.regularMarketTime ?? null,
      is24h: m.instrumentType === 'CRYPTOCURRENCY',
    };
  }

  // Concurrency-limited batch. Yahoo tolerates parallel chart requests far
  // better than it tolerates one giant one, but a proxy in front will rate
  // limit, so keep the width modest.
  async function fetchQuotes(symbols, { concurrency = 6, onProgress } = {}) {
    const out = [];
    let idx = 0, done = 0;
    async function worker() {
      while (idx < symbols.length) {
        const s = symbols[idx++];
        try { out.push(await fetchQuote(s)); } catch { /* skip unresolvable */ }
        if (onProgress) onProgress(++done, symbols.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
    const order = new Map(symbols.map((s, i) => [s.toUpperCase(), i]));
    return out.sort((a, b) => (order.get(a.symbol?.toUpperCase()) ?? 0) - (order.get(b.symbol?.toUpperCase()) ?? 0));
  }

  async function search(query) {
    const url = `${YF}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`;
    const json = await getJSON(url, 8000);
    return (json?.quotes || [])
      .filter(q => q.symbol && q.quoteType !== 'OPTION')
      .map(q => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || q.symbol,
        type: (q.quoteType || '').toLowerCase(),
        exchange: q.exchDisp || q.exchange || '',
      }));
  }

  /* ── Session helpers ─────────────────────────────────────────────────
     Bars are already in exchange-local time, so a calendar day is just a
     division. `sessionKey` anchors VWAP; `periodKey` anchors pivots to the
     previous day (intraday) or month (daily and slower). */
  const DAY = 86400;
  const sessionKey = bar => Math.floor(bar.time / DAY);
  function periodKeyFor(tfId) {
    if (isIntraday(tfId)) return bar => Math.floor(bar.time / DAY);
    return bar => {                                  // calendar month
      const d = new Date(bar.time * 1000);
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    };
  }

  /* ── Live update ──────────────────────────────────────────────────────
     Extends the forming candle, or opens a new one — but only when a new
     bucket has genuinely started AND the market is actually trading. The old
     build advanced the bucket on wall-clock alone, so an overnight 1-minute
     chart accumulated hundreds of invented flat candles.                    */
  function marketOpen(meta, nowSec = Date.now() / 1000) {
    if (meta.is24h) return true;
    if (meta.sessionStart == null || meta.sessionEnd == null) return false;
    return nowSec >= meta.sessionStart && nowSec < meta.sessionEnd;
  }

  // Returns { bar, isNew } describing what the chart should render, or null
  // when nothing legitimately changed.
  function applyTick(bars, meta, price, nowSec = Date.now() / 1000) {
    if (!bars.length || !(price > 0)) return null;
    const last = bars[bars.length - 1];
    const secs = meta.tfSecs || 86400;

    // Outside trading hours only the last close is meaningful; never invent
    // a bar, and never drift the completed candle.
    if (!marketOpen(meta, nowSec)) return null;

    // All arithmetic runs in true UTC and only the emitted stamp is shifted,
    // so the function stays correct no matter how the caller built `bars`.
    const lastUtc = last.utc ?? last.time;
    const localNow = nowSec + tzOffset(nowSec, meta.timezone);

    // Daily and slower: the bucket is the session, so keep extending the last
    // bar for as long as the session is open rather than doing modular math
    // on a stamp that sits at 09:30, not midnight.
    if (secs >= DAY) {
      const localBar = lastUtc + tzOffset(lastUtc, meta.timezone);
      if (Math.floor(localNow / DAY) === Math.floor(localBar / DAY)) {
        last.close = price;
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        return { bar: last, isNew: false };
      }
      return null;   // a new session's first bar must come from a real fetch
    }

    // Intraday: bars sit on a grid anchored to the session open, so derive the
    // bucket from the last known bar rather than from epoch zero.
    const elapsed = nowSec - lastUtc;
    if (elapsed < 0) return null;
    if (elapsed < secs) {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      return { bar: last, isNew: false };
    }
    // A whole bucket has elapsed. Only open one if it still falls inside the
    // session — otherwise the gap is the overnight break.
    const nextUtc = lastUtc + Math.floor(elapsed / secs) * secs;
    if (!meta.is24h && meta.sessionEnd != null && nextUtc >= meta.sessionEnd) return null;
    const bar = {
      time: nextUtc + tzOffset(nextUtc, meta.timezone), utc: nextUtc,
      open: price, high: price, low: price, close: price, volume: 0,
    };
    bars.push(bar);
    return { bar, isNew: true };
  }

  /* ── Formatting ──────────────────────────────────────────────────────── */
  function decimalsFor(price) {
    const p = Math.abs(price);
    if (p >= 1000) return 2;
    if (p >= 10) return 2;
    if (p >= 1) return 3;
    if (p >= 0.01) return 5;
    return 8;
  }
  function fmtPrice(v, decimals) {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(decimals ?? decimalsFor(v));
  }
  function fmtVolume(v) {
    if (!v) return '0';
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  return {
    YF, TIMEFRAMES, TF, isIntraday,
    tzOffset, getJSON, setDirect, chartURL, parseChart,
    fetchBars, fetchQuote, fetchQuotes, search,
    sessionKey, periodKeyFor, marketOpen, applyTick, isStub, reconcileAuctions,
    decimalsFor, fmtPrice, fmtVolume,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
