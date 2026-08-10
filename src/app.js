/* ═══════════════════════════════════════════════════════════════════════
   APP — a multi-chart workspace around TradingView's embedded widgets
   ───────────────────────────────────────────────────────────────────────
   Each cell holds a TradingView Advanced Chart widget, so the candles, the
   indicator library, the drawing tools and the data are all theirs — served
   and licensed by them. What this app adds is what their free embed does
   not: several charts side by side, a watchlist that drives them, symbol
   search, saved layouts and keyboard control.

   One consequence worth knowing: the widget is a cross-origin iframe, so
   nothing inside it can be read back. Symbols are therefore driven from here
   and a change is applied by rebuilding the widget. Anything changed inside
   the chart — interval, indicators, drawings — is TradingView's to keep and
   is not part of the saved layout.
   ═══════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const INTERVALS = [
    { id: '1', label: '1m' }, { id: '5', label: '5m' }, { id: '15', label: '15m' },
    { id: '30', label: '30m' }, { id: '60', label: '1H' }, { id: '240', label: '4H' },
    { id: 'D', label: '1D' }, { id: 'W', label: '1W' }, { id: 'M', label: '1M' },
  ];

  const DEFAULT_SYMBOLS = ['NASDAQ:AAPL', 'NASDAQ:NVDA', 'NASDAQ:TSLA',
                           'AMEX:SPY', 'NASDAQ:MSFT', 'BINANCE:BTCUSDT'];

  const state = {
    layout: '1',
    active: 0,
    cells: [],
    interval: '15',
    style: '1',                  // 1 = candles
    theme: 'dark',
    timezone: 'America/New_York',
    hideSideToolbar: false,
    withVolume: true,
  };

  const STORE = {
    get(k, d) { try { const v = localStorage.getItem('tc2:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('tc2:' + k, JSON.stringify(v)); } catch {} },
  };

  /* ══ Symbols ═════════════════════════════════════════════════════
     TradingView wants EXCHANGE:TICKER but resolves a bare ticker too. A
     small map covers the names typed most often, so the right exchange is
     used instead of whatever TradingView would guess. */
  const EXCHANGE_HINTS = {
    AAPL: 'NASDAQ', MSFT: 'NASDAQ', NVDA: 'NASDAQ', TSLA: 'NASDAQ', AMZN: 'NASDAQ',
    META: 'NASDAQ', GOOGL: 'NASDAQ', GOOG: 'NASDAQ', AVGO: 'NASDAQ', NFLX: 'NASDAQ',
    AMD: 'NASDAQ', COIN: 'NASDAQ', MSTR: 'NASDAQ', PLTR: 'NASDAQ', HOOD: 'NASDAQ',
    RIVN: 'NASDAQ', SOFI: 'NASDAQ', ADBE: 'NASDAQ', QQQ: 'NASDAQ', TLT: 'NASDAQ',
    GME: 'NYSE', JPM: 'NYSE', V: 'NYSE', MA: 'NYSE', UNH: 'NYSE', XOM: 'NYSE',
    CVX: 'NYSE', LLY: 'NYSE', JNJ: 'NYSE', WMT: 'NYSE', PG: 'NYSE', HD: 'NYSE',
    MRK: 'NYSE', KO: 'NYSE', DIS: 'NYSE', BA: 'NYSE', F: 'NYSE', T: 'NYSE',
    SPY: 'AMEX', IWM: 'AMEX', DIA: 'AMEX', GLD: 'AMEX', VIXY: 'AMEX',
  };
  const CRYPTO = {
    BTC: 'BINANCE:BTCUSDT', ETH: 'BINANCE:ETHUSDT', SOL: 'BINANCE:SOLUSDT',
    DOGE: 'BINANCE:DOGEUSDT', XRP: 'BINANCE:XRPUSDT', ADA: 'BINANCE:ADAUSDT',
  };
  const INDEX = { SPX: 'SP:SPX', NDX: 'NASDAQ:NDX', DJI: 'DJ:DJI', VIX: 'CBOE:VIX', RUT: 'RUSSELL:RUT' };

  function normalise(input) {
    let s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return '';
    if (s.includes(':')) return s;                     // already qualified
    s = s.replace(/^[\^$]/, '');                       // ^SPX / $SPX
    if (INDEX[s]) return INDEX[s];
    if (CRYPTO[s]) return CRYPTO[s];
    const pair = /^([A-Z]{2,6})(?:-|\/)?(USD|USDT)$/.exec(s);
    if (pair) return CRYPTO[pair[1]] || `BINANCE:${pair[1]}USDT`;
    const hint = EXCHANGE_HINTS[s];
    return hint ? `${hint}:${s}` : s;                  // let TradingView resolve the rest
  }
  const shortName = sym => String(sym).split(':').pop();

  /* ══ Chart cells ═════════════════════════════════════════════════
     The embed exposes no method to change a symbol after construction, so a
     change tears the widget down and builds a new one. That is a full iframe
     load, which is why it only happens when the symbol actually differs. */
  function createCell(idx, symbol) {
    const el = document.createElement('section');
    el.className = 'cell';
    el.dataset.idx = idx;
    el.innerHTML = `
      <div class="cell-bar">
        <input class="sym-input" spellcheck="false" aria-label="Symbol">
        <span class="cell-hint"></span>
        <div class="spacer"></div>
        <button class="btn icon cell-search" title="Search symbol"><svg viewBox="0 0 16 16"><use href="#i-search"/></svg></button>
      </div>
      <div class="cell-chart"><div class="chart-mount"></div></div>`;

    const cell = {
      idx, el,
      symbol: symbol || DEFAULT_SYMBOLS[idx] || 'NASDAQ:AAPL',
      widget: null,
      els: { bar: $('.cell-bar', el), sym: $('.sym-input', el), hint: $('.cell-hint', el), mount: $('.chart-mount', el) },
    };

    cell.els.sym.value = shortName(cell.symbol);
    cell.els.sym.addEventListener('keydown', e => {
      if (e.key === 'Enter') { setSymbol(cell, cell.els.sym.value); cell.els.sym.blur(); }
      if (e.key === 'Escape') { cell.els.sym.value = shortName(cell.symbol); cell.els.sym.blur(); }
    });
    cell.els.sym.addEventListener('focus', () => cell.els.sym.select());
    $('.cell-search', el).addEventListener('click', () => { setActive(cell.idx); openSearch(); });
    el.addEventListener('pointerdown', () => setActive(cell.idx), true);
    return cell;
  }

  let mountSeq = 0;
  function mountWidget(cell) {
    if (!window.TradingView) return;
    // In a grid, the widget's own side rail and date-range footer eat most of
    // a small cell. A single chart gets the full furniture; tiles get the
    // chart. The Settings toggle can still force the drawing rail off.
    const multi = state.cells.length > 1;
    // Clearing first stops a stale chart flashing underneath the new one.
    cell.els.mount.innerHTML = '';
    const host = document.createElement('div');
    host.id = `tvm-${cell.idx}-${++mountSeq}`;
    host.style.height = '100%';
    cell.els.mount.append(host);
    cell.els.hint.textContent = '';

    try {
      cell.widget = new window.TradingView.widget({
        container_id: host.id,
        symbol: cell.symbol,
        interval: state.interval,
        autosize: true,
        timezone: state.timezone,
        theme: state.theme,
        style: state.style,
        locale: 'en',
        toolbar_bg: '#0B0E14',
        enable_publishing: false,
        allow_symbol_change: false,   // this app owns the symbol, so it can save it
        hide_side_toolbar: state.hideSideToolbar || multi,
        withdateranges: !multi,
        details: false,
        // The widget already overlays volume on the price pane, so adding the
        // study as well drew it twice. Only the hide flag is ours to set.
        hide_volume: !state.withVolume,
        overrides: {
          'paneProperties.background': '#0B0E14',
          'paneProperties.backgroundType': 'solid',
          'paneProperties.vertGridProperties.color': '#151C28',
          'paneProperties.horzGridProperties.color': '#151C28',
          'scalesProperties.textColor': '#7C8AA5',
          'scalesProperties.lineColor': '#212A3A',
          'mainSeriesProperties.candleStyle.upColor': '#2EBD85',
          'mainSeriesProperties.candleStyle.downColor': '#F0616D',
          'mainSeriesProperties.candleStyle.borderUpColor': '#2EBD85',
          'mainSeriesProperties.candleStyle.borderDownColor': '#F0616D',
          'mainSeriesProperties.candleStyle.wickUpColor': '#2EBD85',
          'mainSeriesProperties.candleStyle.wickDownColor': '#F0616D',
        },
      });
    } catch {
      cell.els.hint.textContent = 'chart failed to load';
    }
  }

  function setSymbol(cell, input, opts = {}) {
    if (!cell) return;
    const sym = normalise(input);
    if (!sym) { cell.els.sym.value = shortName(cell.symbol); return; }
    cell.els.sym.value = shortName(sym);
    if (sym === cell.symbol && cell.widget) return;     // nothing to rebuild
    cell.symbol = sym;
    mountWidget(cell);
    if (!opts.silent) saveLayout();
  }

  function destroyCell(cell) {
    try { cell.widget?.remove?.(); } catch {}
    cell.els.mount.innerHTML = '';
    cell.el.remove();
  }

  /* ══ Layout ══════════════════════════════════════════════════════ */
  const LAYOUT_COUNT = { '1': 1, '2': 2, '2v': 2, '3': 3, '4': 4, '6': 6 };

  function setLayout(id, opts = {}) {
    const want = LAYOUT_COUNT[id] || 1;
    const grid = $('#grid');
    state.layout = id;
    grid.dataset.layout = id;
    $$('#layouts .btn').forEach(b => b.classList.toggle('on', b.dataset.layout === id));

    const before = state.cells.length;
    while (state.cells.length > want) destroyCell(state.cells.pop());
    while (state.cells.length < want) {
      const cell = createCell(state.cells.length, (opts.symbols || [])[state.cells.length]);
      state.cells.push(cell);
      grid.append(cell.el);
    }
    state.cells.forEach((c, i) => { c.idx = i; c.el.dataset.idx = i; });
    // Mount only once every cell exists, so each widget knows whether it is
    // alone or in a grid. Crossing the 1-vs-many line changes the furniture,
    // so those widgets have to be rebuilt too.
    const crossed = (before <= 1) !== (want <= 1);
    state.cells.forEach(c => { if (!c.widget || crossed) mountWidget(c); });
    setActive(Math.min(state.active, state.cells.length - 1));
    if (!opts.skipSave) saveLayout();
  }

  function setActive(i) {
    state.active = clamp(i, 0, Math.max(0, state.cells.length - 1));
    state.cells.forEach((c, j) => c.el.classList.toggle('active', j === state.active));
  }
  const activeCell = () => state.cells[state.active];
  const remountAll = () => { state.cells.forEach(mountWidget); saveLayout(); };

  function saveLayout() {
    STORE.set('layout', {
      layout: state.layout, active: state.active,
      interval: state.interval, style: state.style, timezone: state.timezone,
      hideSideToolbar: state.hideSideToolbar, withVolume: state.withVolume,
      symbols: state.cells.map(c => c.symbol),
    });
  }

  function restoreLayout() {
    const s = STORE.get('layout', null);
    if (!s) { setLayout('1', { skipSave: true }); return; }
    state.interval = s.interval || '15';
    state.style = s.style || '1';
    state.timezone = s.timezone || 'America/New_York';
    state.hideSideToolbar = !!s.hideSideToolbar;
    state.withVolume = s.withVolume !== false;
    state.active = s.active || 0;
    setLayout(s.layout || '1', { symbols: s.symbols || [], skipSave: true });
  }

  /* ══ Panels ══════════════════════════════════════════════════════ */
  function openPanel(id) {
    const panel = $('#' + id);
    const wasOpen = panel.classList.contains('open');
    $$('.panel').forEach(p => p.classList.remove('open'));
    if (!wasOpen) panel.classList.add('open');
    return !wasOpen;
  }
  const closePanels = () => $$('.panel').forEach(p => p.classList.remove('open'));

  /* TradingView's other embeds are script tags that hydrate the div they sit
     in, so each is rebuilt by replacing its container. */
  function mountEmbed(container, widget, config) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'tradingview-widget-container';
    wrap.style.height = '100%';
    const inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    inner.style.height = '100%';
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${widget}.js`;
    script.textContent = JSON.stringify(config);
    wrap.append(inner, script);
    container.append(wrap);
  }

  const screenerConfig = () => ({
    width: '100%', height: '100%', defaultColumn: 'overview', defaultScreen: 'most_capitalized',
    market: 'america', showToolbar: true, colorTheme: state.theme, locale: 'en', isTransparent: true,
  });
  const newsConfig = () => {
    const sym = activeCell()?.symbol;
    return {
      displayMode: 'regular', width: '100%', height: '100%',
      colorTheme: state.theme, locale: 'en', isTransparent: true,
      ...(sym ? { feedMode: 'symbol', symbol: sym } : { feedMode: 'market', market: 'stock' }),
    };
  };

  /* — watchlist — */
  let watchlist = [];
  function renderWatchlist() {
    const body = $('#watchlist-body');
    if (!watchlist.length) {
      body.innerHTML = '<div class="empty">No symbols yet.<br>Add one below to jump between them.</div>';
      return;
    }
    body.textContent = '';
    for (const sym of watchlist) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<div class="row-main"><div class="row-sym">${esc(shortName(sym))}</div>
          <div class="row-name">${esc(sym)}</div></div>
        <button class="row-del" title="Remove"><svg viewBox="0 0 16 16"><use href="#i-close"/></svg></button>`;
      row.addEventListener('click', e => {
        if (e.target.closest('.row-del')) {
          watchlist = watchlist.filter(x => x !== sym);
          STORE.set('watchlist', watchlist);
          renderWatchlist();
          return;
        }
        setSymbol(activeCell(), sym);
      });
      body.append(row);
    }
  }
  function addToWatchlist(input) {
    const sym = normalise(input);
    if (!sym) return;
    if (watchlist.includes(sym)) { toast(`${shortName(sym)} is already listed`); return; }
    watchlist.push(sym);
    STORE.set('watchlist', watchlist);
    renderWatchlist();
    toast(`${shortName(sym)} added`);
  }

  /* ══ Symbol search ═══════════════════════════════════════════════
     TradingView's own symbol-search endpoint, the one their widgets use. If
     it is unreachable the typed text still resolves, so the overlay never
     becomes a dead end. */
  let searchTimer = null, results = [], sel = 0;

  function openSearch() {
    $('#search-overlay').classList.add('open');
    const input = $('#search-input');
    input.value = ''; input.focus();
    results = []; sel = 0;
    $('#search-results').innerHTML = '<div class="empty">Type a ticker.</div>';
  }
  const closeSearch = () => $('#search-overlay').classList.remove('open');

  async function runSearch(q) {
    if (!q) { results = []; $('#search-results').innerHTML = '<div class="empty">Type a ticker.</div>'; return; }
    try {
      const r = await fetch('https://symbol-search.tradingview.com/symbol_search/?text='
        + encodeURIComponent(q) + '&hl=0&lang=en&type=&domain=production');
      if (!r.ok) throw new Error('unavailable');
      const rows = await r.json();
      const clean = s => String(s || '').replace(/<\/?em>/g, '');
      results = (rows || []).slice(0, 12).map(x => ({
        symbol: `${x.exchange}:${clean(x.symbol)}`,
        name: clean(x.description),
        exchange: x.exchange || '',
        type: x.type || '',
      }));
    } catch {
      // Fall back to the typed text so Enter still loads something sensible.
      results = [{ symbol: normalise(q), name: 'Use as typed', exchange: '', type: '' }];
    }
    sel = 0;
    renderResults();
  }

  function renderResults() {
    const box = $('#search-results');
    if (!results.length) { box.innerHTML = '<div class="empty">Nothing found.</div>'; return; }
    box.textContent = '';
    results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (i === sel ? ' sel' : '');
      row.innerHTML = `<div class="row-main"><div class="row-sym">${esc(shortName(r.symbol))}</div>
          <div class="row-name">${esc(r.name)}</div></div>
        <div class="row-right"><div class="row-name">${esc(r.exchange)}${r.type ? ' · ' + esc(r.type) : ''}</div></div>`;
      row.addEventListener('click', () => pick(i));
      box.append(row);
    });
  }

  function pick(i) {
    const r = results[i];
    if (!r) return;
    closeSearch();
    setSymbol(activeCell(), r.symbol);
  }

  /* ══ Settings ════════════════════════════════════════════════════ */
  const STYLES = [
    { id: '1', name: 'Candles' }, { id: '9', name: 'Hollow candles' }, { id: '0', name: 'Bars' },
    { id: '8', name: 'Heikin-Ashi' }, { id: '2', name: 'Line' }, { id: '3', name: 'Area' },
    { id: '4', name: 'Renko' }, { id: '7', name: 'Line break' },
  ];
  const ZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London',
    'Europe/Berlin', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Australia/Sydney', 'Etc/UTC'];

  function openSettings() {
    openPanel('panel-settings');
    const body = $('#settings-body');
    body.textContent = '';
    const group = t => { const h = document.createElement('div'); h.className = 'label group-label'; h.textContent = t; body.append(h); };
    const select = (label, value, options, onChange) => {
      const row = document.createElement('div'); row.className = 'setting';
      const l = document.createElement('label'); l.textContent = label;
      const s = document.createElement('select'); s.className = 'field'; s.style.width = '150px';
      for (const o of options) { const opt = document.createElement('option'); opt.value = o.id; opt.textContent = o.name; s.append(opt); }
      s.value = value;
      s.addEventListener('change', () => onChange(s.value));
      row.append(l, s); body.append(row);
    };
    const toggle = (label, value, hint, onChange) => {
      const row = document.createElement('div'); row.className = 'setting';
      const l = document.createElement('label');
      l.innerHTML = `${esc(label)}${hint ? `<div style="font-size:11px;color:var(--dim)">${esc(hint)}</div>` : ''}`;
      const b = document.createElement('button');
      b.className = 'btn' + (value ? ' on' : ''); b.textContent = value ? 'On' : 'Off';
      b.addEventListener('click', () => { onChange(!value); openSettings(); });
      row.append(l, b); body.append(row);
    };

    group('Charts');
    select('Interval', state.interval, INTERVALS.map(i => ({ id: i.id, name: i.label })),
      v => { state.interval = v; remountAll(); });
    select('Candle type', state.style, STYLES, v => { state.style = v; remountAll(); });
    select('Time zone', state.timezone, ZONES.map(z => ({ id: z, name: z.replace(/_/g, ' ') })),
      v => { state.timezone = v; remountAll(); });
    select('Theme', state.theme, [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }],
      v => { state.theme = v; document.body.dataset.theme = v; remountAll(); });
    toggle('Volume', state.withVolume, 'Show the volume study on every chart.',
      v => { state.withVolume = v; remountAll(); });
    toggle('Drawing toolbar', !state.hideSideToolbar, "TradingView's drawing tools down the left of each chart.",
      v => { state.hideSideToolbar = !v; remountAll(); });

    group('About the data');
    const note = document.createElement('div');
    note.className = 'empty'; note.style.textAlign = 'left';
    note.innerHTML = `Charts, prices and indicators are TradingView's, shown through their
      embedded widget. For US equities the free widget carries <b>Cboe One</b> — a single-venue
      feed, roughly a tenth of consolidated volume — so figures match a free TradingView
      account rather than the full tape. Signing in to TradingView in this browser applies
      whatever data you are entitled to.
      <div style="margin-top:8px">Interval, indicators and drawings changed <i>inside</i> a chart
      belong to TradingView and are not part of the saved layout. Symbols set from here are.</div>`;
    body.append(note);

    const reset = document.createElement('div'); reset.className = 'setting';
    const rb = document.createElement('button');
    rb.className = 'btn'; rb.textContent = 'Reset workspace'; rb.style.color = 'var(--down)';
    rb.addEventListener('click', () => {
      if (!confirm('Reset layout, watchlist and settings?')) return;
      try { Object.keys(localStorage).filter(k => k.startsWith('tc2:')).forEach(k => localStorage.removeItem(k)); } catch {}
      location.reload();
    });
    reset.append(rb); body.append(reset);
  }

  /* ══ Misc ════════════════════════════════════════════════════════ */
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 4000 : 2000);
  }

  /* ══ Wiring ══════════════════════════════════════════════════════ */
  function wire() {
    $('#layouts').addEventListener('click', e => {
      const b = e.target.closest('[data-layout]');
      if (b) setLayout(b.dataset.layout);
    });
    $('#btn-search').addEventListener('click', openSearch);
    $('#btn-sync').addEventListener('click', () => {
      const sym = activeCell()?.symbol;
      if (!sym) return;
      state.cells.forEach(c => setSymbol(c, sym, { silent: true }));
      saveLayout();
      toast(`All charts on ${shortName(sym)}`);
    });
    $('#btn-watchlist').addEventListener('click', () => { if (openPanel('panel-watchlist')) renderWatchlist(); });
    $('#btn-screener').addEventListener('click', () => { if (openPanel('panel-screener')) mountEmbed($('#screener-body'), 'screener', screenerConfig()); });
    $('#btn-news').addEventListener('click', () => { if (openPanel('panel-news')) mountEmbed($('#news-body'), 'timeline', newsConfig()); });
    $('#btn-settings').addEventListener('click', openSettings);
    $$('[data-close-panel]').forEach(b => b.addEventListener('click', closePanels));

    $('#watchlist-add-btn').addEventListener('click', () => {
      addToWatchlist($('#watchlist-add').value); $('#watchlist-add').value = '';
    });
    $('#watchlist-add').addEventListener('keydown', e => {
      if (e.key === 'Enter') { addToWatchlist(e.target.value); e.target.value = ''; }
    });

    const input = $('#search-input');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      searchTimer = setTimeout(() => runSearch(q), 200);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); renderResults(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderResults(); e.preventDefault(); }
      else if (e.key === 'Enter') {
        if (results.length) pick(sel);
        else { closeSearch(); setSymbol(activeCell(), input.value); }
      }
    });
    $('#search-overlay').addEventListener('click', e => { if (e.target.id === 'search-overlay') closeSearch(); });

    document.addEventListener('keydown', e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape') {
        if ($('#search-overlay').classList.contains('open')) closeSearch(); else closePanels();
        return;
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); openSearch(); }
      else if (e.key >= '1' && e.key <= '6' && !e.metaKey && !e.ctrlKey) {
        setLayout(['1', '2', '2v', '3', '4', '6'][+e.key - 1]);
      } else if (e.key.toLowerCase() === 'w') { if (openPanel('panel-watchlist')) renderWatchlist(); }
      else if (e.key.toLowerCase() === 's') { if (openPanel('panel-screener')) mountEmbed($('#screener-body'), 'screener', screenerConfig()); }
      else if (e.key.toLowerCase() === 'n') { if (openPanel('panel-news')) mountEmbed($('#news-body'), 'timeline', newsConfig()); }
    });
  }

  /* ══ Boot ════════════════════════════════════════════════════════ */
  function boot() {
    if (!window.TradingView) {
      $('#grid').innerHTML = '<div class="empty" style="padding-top:18vh">'
        + "TradingView's chart library could not load.<br>Check your connection, or any extension "
        + 'blocking tradingview.com, and reload.</div>';
      return;
    }
    document.body.dataset.theme = state.theme;
    watchlist = STORE.get('watchlist', ['NASDAQ:AAPL', 'NASDAQ:NVDA', 'NASDAQ:TSLA', 'AMEX:SPY']);
    wire();
    restoreLayout();
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
