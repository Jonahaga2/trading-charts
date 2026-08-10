/* ═══════════════════════════════════════════════════════════════════════
   DATA — Alpaca Market Data adapter
   ───────────────────────────────────────────────────────────────────────
   Replaces Yahoo, which proved unreliable in ways that could not be coded
   around: its intraday feed omits the opening and closing auctions (the
   official open fell outside the range of its own 09:30 one-minute bar on
   5 sessions in 8), its intraday volume runs 11–24% under its own daily
   figure, and it rate-limits aggressively.

   Measured against the same ground truth, Alpaca's SIP feed reproduces the
   official prints exactly — AAPL 2026-08-04 opens at 302.725 against an
   official 302.73 — and it sends `Access-Control-Allow-Origin: *`, so the
   browser calls it directly and no third-party CORS proxy ever sees the
   traffic or the credentials.

   The one real cost: on the free plan SIP is embargoed for the most recent
   15 minutes. So history comes from SIP (exact, deep, auctions included)
   and the last few bars come from IEX, which is genuinely real-time but is
   a single venue. Those bars are flagged `provisional` and are replaced by
   the authoritative SIP values as soon as they age past the embargo. The
   UI says which is which rather than pretending the tail is consolidated.
   ═══════════════════════════════════════════════════════════════════════ */
const DATA = (() => {
  'use strict';

  const DATA_HOST = 'https://data.alpaca.markets';
  const SIP_EMBARGO_SEC = 16 * 60;      // 15 min, plus a minute of slack

  /* ── Credentials ──────────────────────────────────────────────────────
     Held in localStorage and sent straight to Alpaca. Because the requests
     are direct, the key never transits a proxy. It is still a browser-side
     secret on a public page, so the UI tells the user to use paper keys. */
  let creds = { key: '', secret: '', paper: true };
  function setCreds(key, secret, paper = true) {
    creds = { key: (key || '').trim(), secret: (secret || '').trim(), paper: !!paper };
    _calendar = null; _assets = null;
  }
  const hasCreds = () => !!(creds.key && creds.secret);
  const tradingHost = () => creds.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';

  function loadCreds() {
    try {
      const raw = localStorage.getItem('tc:alpaca');
      if (raw) { const c = JSON.parse(raw); setCreds(c.key, c.secret, c.paper !== false); }
    } catch {}
    return hasCreds();
  }
  function saveCreds(key, secret, paper) {
    setCreds(key, secret, paper);
    try { localStorage.setItem('tc:alpaca', JSON.stringify(creds)); } catch {}
  }
  function clearCreds() {
    creds = { key: '', secret: '', paper: true };
    try { localStorage.removeItem('tc:alpaca'); } catch {}
  }

  class AuthError extends Error {}
  class NotFound extends Error {}

  /* ── Timeframes ──────────────────────────────────────────────────────
     `lookback` is how much history to pull, in days.

     Alpaca's own 1Hour and 4Hour bars are anchored to the *clock* — 09:00,
     10:00, … — so the first bar of a US equity session covers only 09:30
     to 10:00 and every hourly candle after it is offset by half an hour
     from what TradingView and the rest of the world draw. Both are rebuilt
     here from 30-minute bars, chunked from each session's own open, which
     puts them back on the 09:30 / 10:30 grid. Every other timeframe already
     lands on a grid that contains 09:30, so it is used natively. */
  const TIMEFRAMES = [
    { id: '1m',  label: '1m',  tf: '1Min',   secs: 60,      lookback: 7 },
    { id: '2m',  label: '2m',  tf: '2Min',   secs: 120,     lookback: 14 },
    { id: '5m',  label: '5m',  tf: '5Min',   secs: 300,     lookback: 35 },
    { id: '15m', label: '15m', tf: '15Min',  secs: 900,     lookback: 100 },
    { id: '30m', label: '30m', tf: '30Min',  secs: 1800,    lookback: 200 },
    // `chunk` and the 30Min base exist only to fix the equity session grid.
    // Crypto has no session and no auction, and Alpaca's native hourly bars
    // are already UTC-aligned, so it uses `cryptoTf` unchunked.
    { id: '1h',  label: '1H',  tf: '30Min',  secs: 3600,    lookback: 150, chunk: 2, cryptoTf: '1Hour' },
    { id: '4h',  label: '4H',  tf: '30Min',  secs: 14400,   lookback: 300, chunk: 8, cryptoTf: '4Hour' },
    { id: '1d',  label: '1D',  tf: '1Day',   secs: 86400,   lookback: 3650 },
    { id: '1wk', label: '1W',  tf: '1Week',  secs: 604800,  lookback: 3650 },
    { id: '1mo', label: '1M',  tf: '1Month', secs: 2592000, lookback: 7300 },
  ];
  const TF = Object.fromEntries(TIMEFRAMES.map(t => [t.id, t]));
  const isIntraday = id => TF[id] && TF[id].secs < 86400;
  const DAY = 86400;

  /* ── Symbols ─────────────────────────────────────────────────────────
     Alpaca writes crypto pairs as BASE/QUOTE. Accept the shapes people
     actually type and normalise. Indices are not carried at all, so say so
     plainly instead of returning an empty chart.                          */
  const CRYPTO_BASES = new Set(['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'LTC', 'BCH', 'UNI',
    'AAVE', 'DOGE', 'DOT', 'SHIB', 'XRP', 'USDT', 'USDC', 'YFI', 'MKR', 'SUSHI', 'CRV', 'GRT', 'BAT', 'PEPE', 'TRUMP']);
  const INDEX_ALTERNATIVE = { '^GSPC': 'SPY', '^NDX': 'QQQ', '^IXIC': 'QQQ', '^DJI': 'DIA', '^RUT': 'IWM', '^VIX': 'VIXY' };

  function classify(input) {
    const raw = String(input || '').trim().toUpperCase();
    if (!raw) throw new Error('no symbol');
    if (raw.startsWith('^') || raw.startsWith('$')) {
      const alt = INDEX_ALTERNATIVE[raw];
      throw new NotFound(`${raw} is an index — Alpaca carries stocks, ETFs and crypto only.`
        + (alt ? ` Try ${alt}.` : ''));
    }
    if (raw.includes('/')) return { symbol: raw, crypto: true };
    const m = /^([A-Z0-9]{2,10})(?:-|)(USD|USDT|USDC)$/.exec(raw);
    if (m && CRYPTO_BASES.has(m[1])) return { symbol: `${m[1]}/${m[2] === 'USDT' ? 'USDT' : 'USD'}`, crypto: true };
    return { symbol: raw.replace(/-/g, '.'), crypto: false };   // BRK-B -> BRK.B
  }

  /* ── Exchange timezone ────────────────────────────────────────────────
     Bars are shifted into exchange-local time so the axis reads the way a
     trader expects, and so floor(t / 86400) is the trading day — the key
     VWAP and pivots anchor to. Offsets are resolved per instant so DST
     lands correctly. */
  const _fmt = new Map();
  const formatter = tz => {
    let f = _fmt.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      _fmt.set(tz, f);
    }
    return f;
  };
  const _off = new Map();
  function tzOffset(utcSec, tz) {
    if (!tz || tz === 'UTC') return 0;
    const key = tz + ':' + Math.floor(utcSec / DAY);
    const hit = _off.get(key);
    if (hit !== undefined) return hit;
    const p = Object.fromEntries(formatter(tz).formatToParts(new Date(utcSec * 1000))
      .filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    const v = Math.round(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000 - utcSec);
    _off.set(key, v);
    return v;
  }
  const ET = 'America/New_York';

  /* ── HTTP ────────────────────────────────────────────────────────────
     Direct to Alpaca — no proxy. 200 requests/minute, so back off on 429
     rather than surfacing a failure the user can do nothing about.        */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function api(url, { timeout = 15000, retries = 3 } = {}) {
    if (!hasCreds()) throw new AuthError('Alpaca API key required');
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            'APCA-API-KEY-ID': creds.key,
            'APCA-API-SECRET-KEY': creds.secret,
            'accept': 'application/json',
          },
        });
        if (r.status === 401 || r.status === 403) {
          const body = await r.text().catch(() => '');
          throw new AuthError(/subscription/i.test(body)
            ? 'Your Alpaca plan does not allow this data'
            : 'Alpaca rejected these API keys');
        }
        if ((r.status === 429 || r.status >= 500) && attempt < retries) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        if (!r.ok) throw new Error(`Alpaca returned ${r.status}`);
        return await r.json();
      } catch (e) {
        if (e instanceof AuthError) throw e;
        if (attempt >= retries) throw e;
        await sleep(500 * Math.pow(2, attempt));
      } finally { clearTimeout(timer); }
    }
  }

  // Walks Alpaca's page tokens and concatenates one symbol's bars. Alpaca
  // caps a page at roughly 215 bars whatever `limit` asks for, so a long
  // intraday window genuinely needs tens of pages; stopping at a low count
  // silently truncated the series to a few weeks.
  async function pagedBars(baseUrl, symbol, cap = 40000, maxPages = 60) {
    const out = [];
    let token = null;
    for (let page = 0; page < maxPages; page++) {
      const url = baseUrl + (token ? `&page_token=${encodeURIComponent(token)}` : '');
      const j = await api(url);
      const chunk = j?.bars?.[symbol];
      if (Array.isArray(chunk)) out.push(...chunk);
      token = j?.next_page_token;
      if (!token || out.length >= cap) break;
    }
    return out;
  }

  /* ── Market calendar ──────────────────────────────────────────────────
     Gives the exact regular open and close for every date, including half
     days (the day after Thanksgiving closes at 13:00). Yahoo only ever
     exposed the *current* session, so historical half-days were invisible
     and their bars were filtered wrongly. */
  let _calendar = null;
  async function calendar() {
    if (_calendar) return _calendar;
    // Reach a year ahead so an upcoming half-day is already known, and ten
    // years back so historical sessions filter correctly.
    const end = new Date(Date.now() + 400 * DAY * 1000).toISOString().slice(0, 10);
    const start = new Date(Date.now() - 3700 * DAY * 1000).toISOString().slice(0, 10);
    const rows = await api(`${tradingHost()}/v2/calendar?start=${start}&end=${end}`, { timeout: 20000 });
    _calendar = new Map();
    for (const r of rows || []) {
      const [oh, om] = r.open.split(':').map(Number);
      const [ch, cm] = r.close.split(':').map(Number);
      _calendar.set(r.date, {
        date: r.date,
        openMin: oh * 60 + om,
        closeMin: ch * 60 + cm,
        sessionOpenMin: r.session_open ? +r.session_open.slice(0, 2) * 60 + +r.session_open.slice(2) : 4 * 60,
        sessionCloseMin: r.session_close ? +r.session_close.slice(0, 2) * 60 + +r.session_close.slice(2) : 20 * 60,
      });
    }
    return _calendar;
  }

  // Exchange-local minutes-past-midnight for a UTC instant.
  const localMinutes = (utcSec) => {
    const local = utcSec + tzOffset(utcSec, ET);
    return Math.floor((local % DAY) / 60);
  };
  const localDate = (utcSec) => new Date((utcSec + tzOffset(utcSec, ET)) * 1000).toISOString().slice(0, 10);

  /* ── Bars ────────────────────────────────────────────────────────────── */
  function toBar(b, tz) {
    const utc = Math.floor(new Date(b.t).getTime() / 1000);
    const o = b.o, h = b.h, l = b.l, c = b.c;
    return {
      time: utc + tzOffset(utc, tz), utc,
      open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c,
      volume: b.v || 0,
    };
  }

  function dedupe(bars) {
    bars.sort((a, b) => a.time - b.time);
    const out = [];
    for (const b of bars) {
      if (out.length && out[out.length - 1].time === b.time) out[out.length - 1] = b;
      else out.push(b);
    }
    return out;
  }

  const ADJUSTMENT = { split: 'split', all: 'all', raw: 'raw' };

  /* Groups each session's bars into fixed-size chunks starting at that
     session's own open, which is what makes a rebuilt 1H bar run 09:30→10:30
     rather than 09:00→10:00. A short final chunk is kept: the last hour of a
     half-day is a real, if stubby, candle. */
  function chunkSessions(bars, size) {
    if (size <= 1) return bars;
    const out = [];
    let key = null, acc = null, n = 0;
    for (const b of bars) {
      const k = Math.floor(b.time / DAY);
      if (k !== key || n === size) {
        if (acc) out.push(acc);
        key = k; n = 0;
        acc = { time: b.time, utc: b.utc, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
        if (b.provisional) acc.provisional = true;
      } else {
        acc.high = Math.max(acc.high, b.high);
        acc.low = Math.min(acc.low, b.low);
        acc.close = b.close;
        acc.volume += b.volume;
        if (b.provisional) acc.provisional = true;
      }
      n++;
    }
    if (acc) out.push(acc);
    return out;
  }

  /* ── Auction reconciliation ───────────────────────────────────────────
     Alpaca's daily bars carry the official opening and closing auction
     prints; its intraday bars do not reliably start or end on them. On the
     five sessions to 2026-08-07 the 5-minute open matched the official open
     three times and the close matched once — 08-07 closed 313.30 against an
     official 313.33.

     Both prints belong to known bars, so they are placed exactly: the open
     into the session's first bar, the close into its last, widening that
     bar's range to contain the print. The daily high and low are not
     redistributed, because there is no way to know which bar they belong to
     without inventing one. */
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
      // A gap this large is a mismatched instrument or an adjustment
      // difference, not an auction print. Leave it alone.
      if (Math.abs(d.open - f.open) / f.open < tolerance && d.open !== f.open) {
        f.open = d.open;
        f.high = Math.max(f.high, d.open);
        f.low = Math.min(f.low, d.open);
        patched++;
      }
      // Never overwrite a still-forming bar with a stale daily close.
      if (!l.provisional && Math.abs(d.close - l.close) / l.close < tolerance && d.close !== l.close) {
        l.close = d.close;
        l.high = Math.max(l.high, d.close);
        l.low = Math.min(l.low, d.close);
        patched++;
      }
    }
    return patched;
  }

  async function fetchStockBars(symbol, tfId, opts) {
    const tf = TF[tfId] || TF['1d'];
    const now = Math.floor(Date.now() / 1000);
    const start = new Date((now - tf.lookback * DAY) * 1000).toISOString();
    const adjustment = opts.dividendAdjusted ? ADJUSTMENT.all : ADJUSTMENT.split;

    // Authoritative history, embargoed for the last 15 minutes.
    const sipEnd = new Date((now - SIP_EMBARGO_SEC) * 1000).toISOString();
    const sipUrl = `${DATA_HOST}/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}`
      + `&timeframe=${tf.tf}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(sipEnd)}`
      + `&limit=10000&feed=sip&adjustment=${adjustment}&sort=asc`;
    const sip = await pagedBars(sipUrl, symbol);

    // Real-time tail from IEX, covering only what SIP is not allowed to show.
    let tail = [];
    if (opts.live !== false) {
      const tailStart = new Date((now - SIP_EMBARGO_SEC - tf.secs * 2) * 1000).toISOString();
      const iexUrl = `${DATA_HOST}/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}`
        + `&timeframe=${tf.tf}&start=${encodeURIComponent(tailStart)}`
        + `&limit=500&feed=iex&adjustment=${adjustment}&sort=asc`;
      try { tail = await pagedBars(iexUrl, symbol, 500); } catch { tail = []; }
    }
    return { sip, tail };
  }

  // Authoritative daily bars covering the intraday window, used only to
  // recover the auction prints.
  async function fetchDailyForReconcile(symbol, days, opts) {
    const start = new Date((Date.now() - (days + 5) * DAY * 1000)).toISOString();
    const adjustment = opts.dividendAdjusted ? ADJUSTMENT.all : ADJUSTMENT.split;
    const url = `${DATA_HOST}/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}`
      + `&timeframe=1Day&start=${encodeURIComponent(start)}&limit=10000&feed=sip`
      + `&adjustment=${adjustment}&sort=asc`;
    return (await pagedBars(url, symbol, 5000, 30)).map(b => toBar(b, ET));
  }

  async function fetchCryptoBars(symbol, tfId) {
    const tf = TF[tfId] || TF['1d'];
    const now = Math.floor(Date.now() / 1000);
    const start = new Date((now - tf.lookback * DAY) * 1000).toISOString();
    const url = `${DATA_HOST}/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}`
      + `&timeframe=${tf.cryptoTf || tf.tf}&start=${encodeURIComponent(start)}&limit=10000&sort=asc`;
    return pagedBars(url, symbol);
  }

  /* Filters intraday bars to the regular session unless extended hours are
     requested. Alpaca always returns 04:00–20:00, and the calendar supplies
     each date's real boundaries, so half-days are handled exactly. */
  function filterSession(bars, cal, prePost) {
    if (!cal) return bars;
    return bars.filter(b => {
      const day = cal.get(localDate(b.utc));
      if (!day) return false;                       // not a trading day
      const m = localMinutes(b.utc);
      return prePost
        ? m >= day.sessionOpenMin && m < day.sessionCloseMin
        : m >= day.openMin && m < day.closeMin;
    });
  }

  async function fetchBars(symbolInput, tfId, opts = {}) {
    const { symbol, crypto } = classify(symbolInput);
    const tz = crypto ? 'UTC' : ET;
    let bars, provisionalFrom = Infinity, cal = null;

    const tfDef = TF[tfId] || TF['1d'];
    let patched = 0;

    if (crypto) {
      bars = dedupe((await fetchCryptoBars(symbol, tfId)).map(b => toBar(b, tz)));
    } else {
      const { sip, tail } = await fetchStockBars(symbol, tfId, opts);
      cal = await calendar().catch(() => null);
      let merged = sip.map(b => toBar(b, tz));
      const known = new Set(merged.map(b => b.time));
      for (const b of tail) {
        const bar = toBar(b, tz);
        if (!known.has(bar.time)) { bar.provisional = true; merged.push(bar); }
      }
      merged = dedupe(merged);
      // Session filtering happens before chunking so an hourly bar is built
      // from regular-session halves only, never from a pre-market bar.
      if (isIntraday(tfId)) merged = filterSession(merged, cal, opts.prePost);
      if (tfDef.chunk) merged = chunkSessions(merged, tfDef.chunk);

      // Put the auction prints back. Skipped for extended-hours charts, where
      // the session's first and last bar are pre/post bars the daily bar says
      // nothing about.
      if (isIntraday(tfId) && !opts.prePost && opts.reconcile !== false) {
        try {
          const daily = await fetchDailyForReconcile(symbol, tfDef.lookback, opts);
          patched = reconcileAuctions(merged, daily);
        } catch { patched = null; }
      }
      const firstProv = merged.find(b => b.provisional);
      if (firstProv) provisionalFrom = firstProv.time;
      bars = merged;
    }

    if (!bars.length) {
      throw new NotFound(`No data for ${symbol}. Check the symbol, or the market may not have traded yet.`);
    }

    const last = bars[bars.length - 1];
    const win = crypto ? null : await sessionWindow().catch(() => null);

    return {
      bars,
      meta: {
        symbol, display: symbol, crypto,
        timezone: tz,
        is24h: crypto,
        tfSecs: TF[tfId]?.secs || DAY,
        price: last.close,
        previousClose: previousSessionClose(bars, tz),
        sessionStart: win?.open ?? null,
        sessionEnd: win?.close ?? null,
        preOpen: win?.preOpen ?? null,
        postClose: win?.postClose ?? null,
        halfDay: win?.halfDay ?? false,
        provisionalFrom,
        provisionalCount: bars.filter(b => b.provisional).length,
        auctionsPatched: patched,
        feed: crypto ? 'crypto' : 'sip + iex tail',
      },
    };
  }

  // Close of the session before the most recent one — the reference every
  // day-change percentage is measured from.
  function previousSessionClose(bars, tz) {
    if (bars.length < 2) return null;
    const lastDay = Math.floor(bars[bars.length - 1].time / DAY);
    for (let i = bars.length - 2; i >= 0; i--) {
      if (Math.floor(bars[i].time / DAY) !== lastDay) return bars[i].close;
    }
    return bars[0].open;
  }

  /* ── Session window for the ribbon and the open/closed gate ──────────── */

  // "2026-08-07" plus minutes-past-local-midnight -> true UTC epoch seconds.
  // Two passes, because the offset depends on the instant we are solving for:
  // the first guess can land on the wrong side of a DST change.
  function localToUtc(dateStr, minutes) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const naive = Date.UTC(y, mo - 1, d) / 1000 + minutes * 60;   // as if local were UTC
    let utc = naive - tzOffset(naive, ET);
    utc = naive - tzOffset(utc, ET);
    return utc;
  }

  async function sessionWindow(atUtcSec = Math.floor(Date.now() / 1000)) {
    const cal = await calendar().catch(() => null);
    if (!cal) return null;
    const date = localDate(atUtcSec);
    const day = cal.get(date);
    if (!day) return null;
    return {
      date,
      open: localToUtc(date, day.openMin),
      close: localToUtc(date, day.closeMin),
      preOpen: localToUtc(date, day.sessionOpenMin),
      postClose: localToUtc(date, day.sessionCloseMin),
      halfDay: day.closeMin < 15 * 60,
    };
  }

  /* ── Quotes ───────────────────────────────────────────────────────────
     One snapshot request covers every symbol, which is what makes the
     scanner and the poller cheap: 10 names came back in ~30 ms.           */
  async function fetchQuotes(inputs) {
    const stocks = [], cryptos = [], map = new Map();
    for (const i of inputs) {
      try {
        const c = classify(i);
        map.set(c.symbol, i);
        (c.crypto ? cryptos : stocks).push(c.symbol);
      } catch { /* skip indices and junk */ }
    }
    const out = [];
    if (stocks.length) {
      const list = encodeURIComponent(stocks.join(','));
      // Two requests cover any number of symbols. The daily bars are SIP, so
      // volume and the previous close are consolidated — the IEX snapshot's
      // dailyBar counts one venue and reports roughly 4% of the real figure
      // (NVDA: 4.36M against 106.39M), which would rank a "most active" scan
      // on noise. The snapshot is used only for the live trade price.
      const since = new Date(Date.now() - 8 * DAY * 1000).toISOString();
      const [daily, snaps] = await Promise.all([
        api(`${DATA_HOST}/v2/stocks/bars?symbols=${list}&timeframe=1Day`
          + `&start=${encodeURIComponent(since)}&limit=10000&feed=sip&adjustment=split&sort=asc`),
        api(`${DATA_HOST}/v2/stocks/snapshots?symbols=${list}&feed=iex`).catch(() => ({})),
      ]);
      for (const sym of stocks) {
        const bars = daily?.bars?.[sym];
        const snap = snaps?.[sym];
        const day = bars?.length ? bars[bars.length - 1] : null;
        const prevBar = bars?.length > 1 ? bars[bars.length - 2] : null;
        const live = snap?.latestTrade?.p;
        const price = live ?? day?.c;
        const prev = prevBar?.c ?? snap?.prevDailyBar?.c ?? null;
        if (!(price > 0)) continue;
        out.push({
          symbol: sym, input: map.get(sym) || sym, name: sym,
          price, previousClose: prev,
          change: prev ? price - prev : 0,
          changePct: prev ? (price - prev) / prev * 100 : 0,
          volume: day?.v ?? 0,                       // consolidated
          dayHigh: day?.h ?? null, dayLow: day?.l ?? null, open: day?.o ?? null,
          close: day?.c ?? null,                     // official close, once settled
          tradeTime: snap?.latestTrade?.t ? Math.floor(new Date(snap.latestTrade.t).getTime() / 1000) : null,
          crypto: false,
        });
      }
    }
    if (cryptos.length) {
      const j = await api(`${DATA_HOST}/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(cryptos.join(','))}`);
      for (const [sym, s] of Object.entries(j?.snapshots || {})) {
        const price = s.latestTrade?.p ?? s.dailyBar?.c;
        const prev = s.prevDailyBar?.c ?? null;
        if (!(price > 0)) continue;
        out.push({
          symbol: sym, input: map.get(sym) || sym, name: sym,
          price, previousClose: prev,
          change: prev ? price - prev : 0,
          changePct: prev ? (price - prev) / prev * 100 : 0,
          volume: s.dailyBar?.v ?? 0,
          dayHigh: s.dailyBar?.h ?? null, dayLow: s.dailyBar?.l ?? null,
          open: s.dailyBar?.o ?? null, tradeTime: null, crypto: true,
        });
      }
    }
    const order = new Map(inputs.map((s, i) => [String(s).toUpperCase(), i]));
    return out.sort((a, b) =>
      (order.get(String(a.input).toUpperCase()) ?? 0) - (order.get(String(b.input).toUpperCase()) ?? 0));
  }

  async function fetchQuote(symbol) {
    const [q] = await fetchQuotes([symbol]);
    if (!q) throw new NotFound(`No quote for ${symbol}`);
    return q;
  }

  /* ── Symbol search ───────────────────────────────────────────────────
     Alpaca has no search endpoint, so the tradable asset list is fetched
     once (~11k rows), cached, and filtered locally — which also makes the
     search instant instead of a request per keystroke. */
  let _assets = null, _assetsPromise = null;
  async function assets() {
    if (_assets) return _assets;
    if (!_assetsPromise) {
      _assetsPromise = api(`${tradingHost()}/v2/assets?status=active&asset_class=us_equity`, { timeout: 25000 })
        .then(rows => {
          _assets = (rows || [])
            .filter(a => a.tradable !== false)
            .map(a => ({ symbol: a.symbol, name: a.name || a.symbol, exchange: a.exchange || '' }));
          return _assets;
        })
        .catch(e => { _assetsPromise = null; throw e; });
    }
    return _assetsPromise;
  }

  const CRYPTO_SUGGEST = [...CRYPTO_BASES].map(b => ({ symbol: `${b}/USD`, name: `${b} / US Dollar`, exchange: 'CRYPTO' }));

  async function search(query) {
    const q = String(query || '').trim().toUpperCase();
    if (!q) return [];
    let list = [];
    try { list = await assets(); } catch { list = []; }
    const pool = list.concat(CRYPTO_SUGGEST);
    const starts = [], contains = [];
    for (const a of pool) {
      if (a.symbol.startsWith(q)) starts.push(a);
      else if (a.symbol.includes(q) || a.name.toUpperCase().includes(q)) contains.push(a);
      if (starts.length >= 12) break;
    }
    return starts.concat(contains).slice(0, 12)
      .map(a => ({ symbol: a.symbol, name: a.name, exchange: a.exchange, type: a.exchange === 'CRYPTO' ? 'crypto' : 'equity' }));
  }

  /* ── Session helpers ─────────────────────────────────────────────────── */
  const sessionKey = bar => Math.floor(bar.time / DAY);
  function periodKeyFor(tfId) {
    if (isIntraday(tfId)) return bar => Math.floor(bar.time / DAY);
    return bar => { const d = new Date(bar.time * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  }

  function marketOpen(meta, nowSec = Date.now() / 1000) {
    if (meta.is24h) return true;
    if (meta.sessionStart == null || meta.sessionEnd == null) return false;
    return nowSec >= meta.sessionStart && nowSec < meta.sessionEnd;
  }

  /* ── Live tick ────────────────────────────────────────────────────────
     Extends the forming candle or opens exactly one new one, and only while
     the market is genuinely trading. */
  function applyTick(bars, meta, price, nowSec = Date.now() / 1000) {
    if (!bars.length || !(price > 0)) return null;
    if (!marketOpen(meta, nowSec)) return null;
    const last = bars[bars.length - 1];
    const secs = meta.tfSecs || DAY;
    const lastUtc = last.utc ?? last.time;

    if (secs >= DAY) {
      const dayOf = t => Math.floor((t + tzOffset(t, meta.timezone)) / DAY);
      if (dayOf(nowSec) === dayOf(lastUtc)) {
        last.close = price;
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        return { bar: last, isNew: false };
      }
      return null;
    }

    const elapsed = nowSec - lastUtc;
    if (elapsed < 0) return null;
    if (elapsed < secs) {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      return { bar: last, isNew: false };
    }
    const nextUtc = lastUtc + Math.floor(elapsed / secs) * secs;
    if (!meta.is24h && meta.sessionEnd != null && nextUtc >= meta.sessionEnd) return null;
    const bar = {
      time: nextUtc + tzOffset(nextUtc, meta.timezone), utc: nextUtc,
      open: price, high: price, low: price, close: price, volume: 0, provisional: true,
    };
    bars.push(bar);
    return { bar, isNew: true };
  }

  /* ── Formatting ───────────────────────────────────────────────────────── */
  function decimalsFor(price) {
    const p = Math.abs(price);
    if (p >= 1000) return 2;
    if (p >= 10) return 2;
    if (p >= 1) return 3;
    if (p >= 0.01) return 5;
    return 8;
  }
  const fmtPrice = (v, d) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(d ?? decimalsFor(v));
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
    TIMEFRAMES, TF, isIntraday, DATA_HOST, SIP_EMBARGO_SEC,
    setCreds, saveCreds, loadCreds, clearCreds, hasCreds, tradingHost,
    AuthError, NotFound, classify, tzOffset, api, calendar, sessionWindow,
    fetchBars, fetchQuote, fetchQuotes, search, assets,
    sessionKey, periodKeyFor, marketOpen, applyTick, reconcileAuctions, chunkSessions,
    localDate, localMinutes, previousSessionClose, filterSession,
    decimalsFor, fmtPrice, fmtVolume,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
