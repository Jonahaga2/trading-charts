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
                           'AMEX:SPY', 'NASDAQ:MSFT', 'BINANCE:BTCUSDT',
                           'NASDAQ:AMD', 'NASDAQ:META', 'NASDAQ:QQQ'];

  /* The grid table. `key` is the number key that selects it, so the shortcut
     is the chart count rather than a button position — 9 gives nine charts.
     Two layouts hold two charts, so only the first claims the key. */
  const LAYOUTS = [
    { id: '1',  n: 1, key: '1' },
    { id: '2',  n: 2, key: '2' },
    { id: '2v', n: 2, key: null },
    { id: '3',  n: 3, key: '3' },
    { id: '4',  n: 4, key: '4' },
    { id: '6',  n: 6, key: '6' },
    { id: '9',  n: 9, key: '9' },
  ];
  const LAYOUT_COUNT = Object.fromEntries(LAYOUTS.map(l => [l.id, l.n]));

  /* Everything below `cells` is global on purpose: one control, every chart. */
  const state = {
    layout: '1',
    active: 0,
    cells: [],
    interval: '15',
    style: '1',                  // 1 = candles
    theme: 'dark',
    timezone: 'America/New_York',
    studies: [],
    hideSideToolbar: false,
    hideTopToolbar: false,
    hideLegend: false,
    withVolume: true,
    focus: false,
    // Empty means "whatever the theme says", so the pickers stay out of the
    // way until one is actually used and a theme switch keeps working.
    colors: { up: '', down: '', bg: '', volUp: '', volDown: '' },
  };
  const UP = '#2EBD85', DOWN = '#F0616D';
  const blankColors = () => ({ up: '', down: '', bg: '', volUp: '', volDown: '' });

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

  /* ══ Indicators ══════════════════════════════════════════════════
     The widget takes a `studies` array at construction, so an indicator
     picked here lands on every chart at once — which is the only way to get
     one onto nine charts without opening nine of them.

     TradingView publishes no list of the ids their embed accepts, and a
     wrong one fails silently: the chart loads, the study simply is not
     there. So every id below was checked by mounting it on a live widget and
     reading the legend back (2026-08-10). Ids that did nothing are recorded
     at the bottom rather than dropped, so they do not get re-added later. */
  const STUDIES = [
    // — drawn on the price pane —
    { id: 'MASimple@tv-basicstudies',       g: 'Overlay', name: 'Moving average',      sub: 'SMA' },
    { id: 'MAExp@tv-basicstudies',          g: 'Overlay', name: 'Moving average exp.', sub: 'EMA' },
    { id: 'VWAP@tv-basicstudies',           g: 'Overlay', name: 'VWAP',                sub: 'session anchored' },
    { id: 'BB@tv-basicstudies',             g: 'Overlay', name: 'Bollinger Bands',     sub: '20, 2' },
    { id: 'STD;Keltner_Channels',           g: 'Overlay', name: 'Keltner Channels',    sub: '20, 2' },
    { id: 'STD;Donchian_Channels',          g: 'Overlay', name: 'Donchian Channels',   sub: '20' },
    { id: 'STD;Supertrend',                 g: 'Overlay', name: 'Supertrend',          sub: '10, 3' },
    { id: 'PSAR@tv-basicstudies',           g: 'Overlay', name: 'Parabolic SAR',       sub: '0.02, 0.2' },
    { id: 'IchimokuCloud@tv-basicstudies',  g: 'Overlay', name: 'Ichimoku Cloud',      sub: '9, 26, 52' },
    { id: 'PivotPointsStandard@tv-basicstudies', g: 'Overlay', name: 'Pivot Points',   sub: 'traditional' },
    { id: 'LinearRegression@tv-basicstudies', g: 'Overlay', name: 'Linear Regression', sub: 'channel' },
    { id: 'ZigZag@tv-basicstudies',         g: 'Overlay', name: 'Zig Zag',             sub: '5%, 10' },

    // — each opens its own pane below the price —
    { id: 'RSI@tv-basicstudies',            g: 'Oscillator', name: 'RSI',              sub: '14' },
    { id: 'MACD@tv-basicstudies',           g: 'Oscillator', name: 'MACD',             sub: '12, 26, 9' },
    { id: 'Stochastic@tv-basicstudies',     g: 'Oscillator', name: 'Stochastic',       sub: '14, 3, 3' },
    { id: 'StochasticRSI@tv-basicstudies',  g: 'Oscillator', name: 'Stochastic RSI',   sub: '3, 3, 14, 14' },
    { id: 'ATR@tv-basicstudies',            g: 'Oscillator', name: 'ATR',              sub: '14, RMA' },
    { id: 'STD;DMI',                        g: 'Oscillator', name: 'ADX / DMI',        sub: 'ADX, +DI, −DI' },
    { id: 'MF@tv-basicstudies',             g: 'Oscillator', name: 'Money Flow Index', sub: '14' },
    { id: 'STD;Chaikin_Money_Flow',         g: 'Oscillator', name: 'Chaikin Money Flow', sub: '20' },
    { id: 'OBV@tv-basicstudies',            g: 'Oscillator', name: 'On Balance Volume', sub: '' },
    { id: 'CCI@tv-basicstudies',            g: 'Oscillator', name: 'CCI',              sub: '20' },
    { id: 'WilliamR@tv-basicstudies',       g: 'Oscillator', name: 'Williams %R',      sub: '14' },
    { id: 'AwesomeOscillator@tv-basicstudies', g: 'Oscillator', name: 'Awesome Oscillator', sub: '5, 34' },
    { id: 'MOM@tv-basicstudies',            g: 'Oscillator', name: 'Momentum',         sub: '10' },
    { id: 'ROC@tv-basicstudies',            g: 'Oscillator', name: 'Rate of Change',   sub: '9' },
    { id: 'STD;Choppiness_Index',           g: 'Oscillator', name: 'Choppiness Index', sub: '14' },
    { id: 'STD;Bollinger_Bands_Width',      g: 'Oscillator', name: 'Bollinger Width',  sub: '20, 2' },
  ];
  /* Checked and rejected — the widget accepted the id and drew nothing:
     ParabolicSAR@…, ADX@…, KeltnerChannels@…, DonchianChannels@…,
     RelativeVolumeAtTime@…, ADR@…, STD;ADX, STD;Average_Directional_Index,
     STD;Average_Day_Range, STD;Relative_Volume_at_Time, STD;Vortex_Indicator,
     STD;Volume_Weighted_Moving_Average, STD;Anchored_VWAP.
     Volume Profile (STD;Session_Volume_Profile,
     STD;Volume_Profile_Visible_Range) is a paid TradingView study and does
     not render in the free embed. */

  /* ══ Chart cells ═════════════════════════════════════════════════
     The embed exposes no method to change a symbol after construction, so a
     change tears the widget down and builds a new one. That is a full iframe
     load, which is why it only happens when the symbol actually differs. */
  function createCell(idx, symbol, interval) {
    const el = document.createElement('section');
    el.className = 'cell';
    el.dataset.idx = idx;
    el.innerHTML = `
      <div class="cell-bar">
        <input class="sym-input" spellcheck="false" aria-label="Symbol">
        <select class="tf-select" aria-label="Interval">${
          INTERVALS.map(i => `<option value="${i.id}">${i.label}</option>`).join('')}</select>
        <span class="cell-hint"></span>
        <div class="spacer"></div>
        <button class="btn icon cell-search" title="Search symbol"><svg viewBox="0 0 16 16"><use href="#i-search"/></svg></button>
      </div>
      <div class="cell-chart"><div class="chart-mount"></div></div>`;

    const cell = {
      idx, el,
      symbol: symbol || DEFAULT_SYMBOLS[idx] || 'NASDAQ:AAPL',
      // A chart added to the grid should match what is already on screen, so
      // it follows chart 1 rather than a default the user may have left behind.
      interval: interval || state.cells[0]?.interval || state.interval,
      widget: null,
      els: { bar: $('.cell-bar', el), sym: $('.sym-input', el), tf: $('.tf-select', el),
             hint: $('.cell-hint', el), mount: $('.chart-mount', el) },
    };

    cell.els.tf.value = cell.interval;
    cell.els.tf.addEventListener('change', () => {
      cell.interval = cell.els.tf.value;
      applyAll();
      saveLayout();
    });

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

  /* The chart surface per theme, used whenever no colour has been picked.
     Only a background: it is the one surface colour the embed lets us set. */
  const CHART_SKIN = { dark: '#0B0E14', light: '#FFFFFF' };

  /* The complete widget configuration for a cell. Everything a chart shows
     other than its symbol comes from global state, which is what lets one
     control move all nine at once. Kept as a pure function so it doubles as
     a change signature — see applyAll. */
  /* Candle colours have to be repeated for every series style, because
     TradingView keeps a separate colour pair per style — set only
     candleStyle and the colours vanish the moment you switch to bars or
     Heikin-Ashi. */
  function seriesColours(up, down) {
    const o = {};
    for (const s of ['candleStyle', 'hollowCandleStyle', 'haStyle']) {
      o[`mainSeriesProperties.${s}.upColor`] = up;
      o[`mainSeriesProperties.${s}.downColor`] = down;
      o[`mainSeriesProperties.${s}.borderUpColor`] = up;
      o[`mainSeriesProperties.${s}.borderDownColor`] = down;
      o[`mainSeriesProperties.${s}.wickUpColor`] = up;
      o[`mainSeriesProperties.${s}.wickDownColor`] = down;
    }
    o['mainSeriesProperties.barStyle.upColor'] = up;
    o['mainSeriesProperties.barStyle.downColor'] = down;
    return o;
  }

  /* The colour actually in force for a key: an explicit pick, else the theme. */
  function colourOf(key) {
    const c = state.colors;
    switch (key) {
      case 'up':   return c.up   || UP;
      case 'down': return c.down || DOWN;
      case 'bg':   return c.bg   || CHART_SKIN[state.theme] || CHART_SKIN.dark;
      case 'volUp':   return c.volUp   || c.up   || UP;
      case 'volDown': return c.volDown || c.down || DOWN;
      default: return '#000000';
    }
  }

  /* What the free embed will and will not let us colour, established by
     mounting each against a live widget and looking (2026-08-10):

       backgroundColor (top level)          works, on both themes
       mainSeriesProperties.*Style.*Color   works
       studies_overrides volume.volume.*    works — color.1 is up, color.0 down

       gridColor (top level)                ignored
       paneProperties.background            ignored — `theme` wins
       paneProperties.*GridProperties.color ignored
       scalesProperties.textColor/lineColor ignored

     The ignored ones are the reason there is no grid or axis colour to pick:
     the embed will not honour them, and a control that does nothing is worse
     than no control. They were in this config for months doing nothing —
     the charts were dark because of `theme`, never because of the override. */
  function widgetConfig(cell) {
    const n = state.cells.length;
    const c = state.colors;
    // Only emit a volume override when one was actually picked — otherwise
    // leave TradingView's own translucent bars alone rather than replacing
    // them with flat colour nobody asked for.
    const studiesOverrides = {};
    if (c.volUp) studiesOverrides['volume.volume.color.1'] = c.volUp;
    if (c.volDown) studiesOverrides['volume.volume.color.0'] = c.volDown;
    return {
      symbol: cell.symbol,
      interval: cell.interval,
      autosize: true,
      timezone: state.timezone,
      theme: state.theme,
      style: state.style,
      locale: 'en',
      backgroundColor: colourOf('bg'),
      toolbar_bg: colourOf('bg'),
      enable_publishing: false,
      allow_symbol_change: false,   // this app owns the symbol, so it can save it
      // In a grid the widget's own side rail and date-range footer eat most of
      // a small cell, so tiles get the chart and a single chart gets the lot.
      hide_side_toolbar: state.hideSideToolbar || n > 1,
      // Borderless means the charts and nothing else, and nine copies of the
      // widget's own toolbar is the largest thing left once this app's chrome
      // is gone. The legend stays: that is the reading, not the furniture.
      hide_top_toolbar: state.hideTopToolbar || state.focus,
      hide_legend: state.hideLegend,
      withdateranges: n === 1,
      details: false,
      // The widget already overlays volume on the price pane, so adding the
      // study as well drew it twice. Only the hide flag is ours to set.
      hide_volume: !state.withVolume,
      studies: state.studies,
      studies_overrides: studiesOverrides,
      overrides: seriesColours(colourOf('up'), colourOf('down')),
    };
  }

  let mountSeq = 0;
  function mountWidget(cell, cfg = widgetConfig(cell)) {
    if (!window.TradingView) return;
    cell.sig = JSON.stringify(cfg);
    // Tear the old widget down before dropping its container. Wiping innerHTML
    // alone leaves tv.js holding listeners on a frame that no longer exists,
    // which accumulates across every settings change on every chart.
    try { cell.widget?.remove?.(); } catch {}
    // Clearing second stops a stale chart flashing underneath the new one.
    cell.els.mount.innerHTML = '';
    const host = document.createElement('div');
    host.id = `tvm-${cell.idx}-${++mountSeq}`;
    host.style.height = '100%';
    cell.els.mount.append(host);
    cell.els.hint.textContent = '';

    try {
      cell.widget = new window.TradingView.widget({ container_id: host.id, ...cfg });
    } catch {
      cell.els.hint.textContent = 'chart failed to load';
      cell.sig = '';                                    // force a retry next time
    }
  }

  /* Every global change funnels through here. Because the configuration is a
     pure function of state, comparing it against what a cell was built with
     says exactly which charts need rebuilding — so switching theme rebuilds
     nine, and switching layout rebuilds only the ones whose furniture
     changed. */
  const applyAll = () => state.cells.forEach(c => {
    const cfg = widgetConfig(c);
    if (JSON.stringify(cfg) !== c.sig) mountWidget(c, cfg);   // built once, not twice
  });

  /* A rebuild is a full iframe load, and nine of them is not free. Toggling
     four indicators in a row should cost one rebuild, not four, so settings
     changes coalesce. */
  let applyTimer = null;
  function applySoon(ms = 320) {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => { applyAll(); saveLayout(); }, ms);
  }

  /* Rebuild every chart whether or not its configuration changed.
     applyAll compares against what a chart was *built* with, which cannot see
     a change made inside the widget's own toolbar — that happens in a
     cross-origin frame and never reaches this side. So a chart switched to 5m
     from its own toolbar still matches its signature and would be skipped.
     This is the deliberate override that drags those back into line. */
  // Not `forEach(mountWidget)`: forEach passes the index as the second
  // argument, which would land in mountWidget's cfg parameter and build every
  // chart from a number.
  const forceAll = () => { state.cells.forEach(c => mountWidget(c)); saveLayout(); };

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
  function setLayout(id, opts = {}) {
    const want = LAYOUT_COUNT[id] || 1;
    const grid = $('#grid');
    state.layout = id;
    grid.dataset.layout = id;
    $$('#layouts .btn').forEach(b => b.classList.toggle('on', b.dataset.layout === id));

    while (state.cells.length > want) destroyCell(state.cells.pop());
    while (state.cells.length < want) {
      const i = state.cells.length;
      const cell = createCell(i, (opts.symbols || [])[i], (opts.intervals || [])[i]);
      state.cells.push(cell);
      grid.append(cell.el);
    }
    state.cells.forEach((c, i) => { c.idx = i; c.el.dataset.idx = i; });
    // Mount only once every cell exists, so each widget knows whether it is
    // alone or in a grid before it decides what furniture to draw.
    applyAll();
    setActive(Math.min(state.active, state.cells.length - 1));
    if (!opts.skipSave) saveLayout();
  }

  function setActive(i) {
    state.active = clamp(i, 0, Math.max(0, state.cells.length - 1));
    state.cells.forEach((c, j) => c.el.classList.toggle('active', j === state.active));
  }
  const activeCell = () => state.cells[state.active];

  function saveLayout() {
    STORE.set('layout', {
      layout: state.layout, active: state.active,
      interval: state.interval, style: state.style, timezone: state.timezone,
      theme: state.theme, studies: state.studies,
      hideSideToolbar: state.hideSideToolbar, hideTopToolbar: state.hideTopToolbar,
      hideLegend: state.hideLegend, withVolume: state.withVolume,
      focus: state.focus, colors: state.colors,
      symbols: state.cells.map(c => c.symbol),
      intervals: state.cells.map(c => c.interval),
    });
  }

  function restoreLayout() {
    const s = STORE.get('layout', null);
    if (!s) { setLayout('1', { skipSave: true }); return; }
    state.interval = s.interval || '15';
    state.style = s.style || '1';
    state.timezone = s.timezone || 'America/New_York';
    state.theme = s.theme === 'light' ? 'light' : 'dark';
    // Drop anything no longer in the table, so an id that stops working can be
    // retired without stranding a saved workspace on a chart that never draws.
    const known = new Set(STUDIES.map(x => x.id));
    state.studies = (Array.isArray(s.studies) ? s.studies : []).filter(x => known.has(x));
    state.hideSideToolbar = !!s.hideSideToolbar;
    state.hideTopToolbar = !!s.hideTopToolbar;
    state.hideLegend = !!s.hideLegend;
    state.withVolume = s.withVolume !== false;
    state.colors = Object.assign(blankColors(), s.colors || {});
    state.active = s.active || 0;
    state.focus = !!s.focus;
    document.body.dataset.theme = state.theme;
    // Paint before the first mount, so a restored borderless session builds
    // its charts without the toolbar rather than building then rebuilding.
    // Fullscreen is not re-entered: it needs a gesture a page load cannot give.
    paintFocus();
    setLayout(s.layout || '1', {
      symbols: s.symbols || [], intervals: s.intervals || [], skipSave: true,
    });
  }

  /* ══ Borderless ══════════════════════════════════════════════════
     Hides everything this app draws — header, symbol bars, the hairlines
     between tiles — and asks the browser for the screen, so what is left is
     the charts. It also drops the widget's own toolbar, which is the one part
     that is not free: that lives inside the iframe, so it costs a rebuild of
     every chart on the way in and on the way out.

     Real fullscreen needs a user gesture, which a click or a keypress
     provides but a page load does not. So a restored session comes back
     borderless without it, rather than silently failing. */
  function paintFocus() {
    if (state.focus) document.body.dataset.focus = '1';
    else delete document.body.dataset.focus;
    $('#btn-focus').classList.toggle('on', state.focus);
  }

  function setFocus(on) {
    if (!!on === state.focus) return;
    state.focus = !!on;
    paintFocus();
    if (state.focus) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});

    // The way out is a faint pill in the corner, which is right as a resting
    // state and useless as a discovery one. Say it once, plainly, then let it
    // recede.
    if (state.focus) {
      const x = $('#focus-exit');
      x.classList.add('hint');
      setTimeout(() => x.classList.remove('hint'), 2600);
      toast('Borderless — esc or f to come back');
    }
    applyAll();
    saveLayout();
  }

  /* ══ Sync ════════════════════════════════════════════════════════ */
  function syncSymbol() {
    const sym = activeCell()?.symbol;
    if (!sym) return;
    state.cells.forEach(c => setSymbol(c, sym, { silent: true }));
    saveLayout();
    toast(`Every chart on ${shortName(sym)}`);
  }

  const tfLabel = id => INTERVALS.find(i => i.id === id)?.label || id;
  const paintIntervals = () => state.cells.forEach(c => { c.els.tf.value = c.interval; });

  /* Chart 1 is the master. Its interval goes to every other chart, and every
     chart is rebuilt from the settings held here — which is also what drags
     back one that was changed inside TradingView's own toolbar, since that
     happens in a frame this side cannot read. Symbols are left alone. */
  function syncFromFirst() {
    const first = state.cells[0];
    if (!first) return;
    state.interval = first.interval;
    state.cells.forEach(c => { c.interval = first.interval; });
    paintIntervals();
    forceAll();
    const n = state.cells.length;
    toast(`${n} chart${n === 1 ? '' : 's'} matched to ${shortName(first.symbol)} · ${tfLabel(first.interval)}`
      + (state.studies.length ? ` · ${state.studies.length} indicator${state.studies.length === 1 ? '' : 's'}` : ''));
  }

  const closeMenu = () => {
    $('#sync-menu').hidden = true;
    $('#btn-sync').setAttribute('aria-expanded', 'false');
    $('#btn-sync').classList.remove('on');
  };

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

  /* — indicators, applied to every chart at once — */
  function paintStudiesCount() {
    const el = $('#studies-count');
    el.textContent = String(state.studies.length);
    el.hidden = !state.studies.length;
    $('#btn-studies').classList.toggle('on', state.studies.length > 0);
  }

  function openStudies() {
    if (!openPanel('panel-studies')) return;
    $('#studies-filter').value = '';
    renderStudies();
  }

  function renderStudies() {
    const body = $('#studies-body');
    const q = $('#studies-filter').value.trim().toLowerCase();
    const hits = STUDIES.filter(s => !q || `${s.name} ${s.sub} ${s.g}`.toLowerCase().includes(q));
    body.textContent = '';
    if (!hits.length) { body.innerHTML = '<div class="empty">Nothing matches.</div>'; return; }

    let group = null;
    for (const s of hits) {
      if (s.g !== group) {
        group = s.g;
        const h = document.createElement('div');
        h.className = 'label group-label';
        h.textContent = group === 'Overlay' ? 'On the price' : 'Own pane';
        body.append(h);
      }
      const row = document.createElement('div');
      row.className = 'row' + (state.studies.includes(s.id) ? ' on' : '');
      row.innerHTML = `<div class="row-tick"><svg viewBox="0 0 16 16"><use href="#i-check"/></svg></div>
        <div class="row-main"><div class="row-sym">${esc(s.name)}</div>
          ${s.sub ? `<div class="row-name">${esc(s.sub)}</div>` : ''}</div>`;
      row.addEventListener('click', () => {
        const i = state.studies.indexOf(s.id);
        if (i >= 0) state.studies.splice(i, 1); else state.studies.push(s.id);
        row.classList.toggle('on', i < 0);
        paintStudiesCount();
        applySoon();
      });
      body.append(row);
    }
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

  /* Opening toggles the panel; rendering does not. They used to be one
     function, so anything that re-rendered from inside the panel — Reset
     colours — went through openPanel a second time and shut the panel it was
     redrawing. */
  function openSettings() {
    if (openPanel('panel-settings')) renderSettings();
  }

  function renderSettings() {
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
    // Repaints only its own button, so the panel does not rebuild and lose
    // scroll position every time a switch is flipped.
    const toggle = (label, get, hint, set) => {
      const row = document.createElement('div'); row.className = 'setting';
      const l = document.createElement('label');
      l.innerHTML = `${esc(label)}${hint ? `<div style="font-size:11px;color:var(--dim)">${esc(hint)}</div>` : ''}`;
      const b = document.createElement('button');
      const paint = () => { const v = get(); b.className = 'btn' + (v ? ' on' : ''); b.textContent = v ? 'On' : 'Off'; };
      b.addEventListener('click', () => { set(!get()); paint(); applySoon(0); });
      paint();
      row.append(l, b); body.append(row);
    };

    group(`Every chart · ${state.cells.length} on screen`);
    select('Interval', state.interval, INTERVALS.map(i => ({ id: i.id, name: i.label })),
      v => {
        state.interval = v;
        state.cells.forEach(c => { c.interval = v; });   // the default is also a command
        paintIntervals();
        applySoon(0);
      });
    select('Candle type', state.style, STYLES, v => { state.style = v; applySoon(0); });
    select('Time zone', state.timezone, ZONES.map(z => ({ id: z, name: z.replace(/_/g, ' ') })),
      v => { state.timezone = v; applySoon(0); });
    select('Theme', state.theme, [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }],
      v => { state.theme = v; document.body.dataset.theme = v; applySoon(0); });
    toggle('Volume', () => state.withVolume, 'Volume bars under the price on every chart.',
      v => { state.withVolume = v; });
    toggle('Drawing toolbar', () => !state.hideSideToolbar,
      "TradingView's drawing tools down the left. Hidden in a grid regardless — there is no room.",
      v => { state.hideSideToolbar = !v; });
    toggle('Chart toolbar', () => !state.hideTopToolbar,
      'The interval and indicator row along the top of each chart. Borderless hides it regardless.',
      v => { state.hideTopToolbar = !v; });
    toggle('Legend', () => !state.hideLegend, 'OHLC and indicator readout in the top-left of each chart.',
      v => { state.hideLegend = !v; });

    // `change`, not `input`: dragging inside a colour picker fires input
    // continuously, and each one would rebuild every chart.
    const colour = (label, key) => {
      const row = document.createElement('div'); row.className = 'setting';
      const l = document.createElement('label'); l.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = colourOf(key);
      inp.addEventListener('change', () => { state.colors[key] = inp.value; applySoon(200); });
      row.append(l, inp); body.append(row);
    };

    group('Appearance');
    colour('Up', 'up');
    colour('Down', 'down');
    colour('Background', 'bg');
    colour('Volume up', 'volUp');
    colour('Volume down', 'volDown');

    const cr = document.createElement('div'); cr.className = 'setting';
    const cl = document.createElement('label');
    cl.innerHTML = 'Reset colours<div style="font-size:11px;color:var(--dim)">Back to following the theme.</div>';
    const cb = document.createElement('button');
    cb.className = 'btn'; cb.textContent = 'Reset';
    cb.addEventListener("click", () => { state.colors = blankColors(); applySoon(0); renderSettings(); });
    cr.append(cl, cb); body.append(cr);

    const fx = document.createElement('div'); fx.className = 'setting';
    const fl = document.createElement('label');
    fl.innerHTML = 'Indicators<div style="font-size:11px;color:var(--dim)">'
      + `${state.studies.length || 'None'} drawn on every chart.</div>`;
    const fb = document.createElement('button');
    fb.className = 'btn'; fb.textContent = 'Choose';
    fb.addEventListener('click', openStudies);
    fx.append(fl, fb); body.append(fx);

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

    // Every .setting is label-then-control; this row had only a control, so it
    // laid out differently from the rest and broke anything walking the panel.
    const reset = document.createElement('div'); reset.className = 'setting';
    const rl = document.createElement('label');
    rl.innerHTML = 'Reset workspace<div style="font-size:11px;color:var(--dim)">'
      + 'Clears the layout, watchlist, colours and every setting.</div>';
    const rb = document.createElement('button');
    rb.className = 'btn'; rb.textContent = 'Reset'; rb.style.color = 'var(--down)';
    rb.addEventListener('click', () => {
      if (!confirm('Reset layout, watchlist and settings?')) return;
      try { Object.keys(localStorage).filter(k => k.startsWith('tc2:')).forEach(k => localStorage.removeItem(k)); } catch {}
      location.reload();
    });
    reset.append(rl, rb); body.append(reset);
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

    $('#btn-sync').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('#sync-menu');
      if (!m.hidden) return closeMenu();
      m.hidden = false;
      $('#btn-sync').setAttribute('aria-expanded', 'true');
      $('#btn-sync').classList.add('on');
    });
    $('#sync-menu').addEventListener('click', e => {
      const b = e.target.closest('[data-sync]');
      if (!b) return;
      closeMenu();
      if (b.dataset.sync === "symbol") syncSymbol(); else syncFromFirst();
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.menu-wrap')) closeMenu();
    });

    $('#btn-focus').addEventListener('click', () => setFocus(!state.focus));
    $('#focus-exit').addEventListener('click', () => setFocus(false));
    // F11 or the browser's own Escape leaves fullscreen without telling us.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && state.focus) setFocus(false);
    });
    $('#btn-studies').addEventListener('click', openStudies);
    $('#studies-filter').addEventListener('input', renderStudies);
    $('#studies-clear').addEventListener('click', () => {
      if (!state.studies.length) return;
      state.studies.length = 0;
      renderStudies(); paintStudiesCount(); applySoon(0);
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
      // Escape unwinds one layer at a time, innermost first, so it never drops
      // out of borderless while a panel is still covering the charts.
      if (e.key === 'Escape') {
        if ($('#search-overlay').classList.contains('open')) closeSearch();
        else if (!$('#sync-menu').hidden) closeMenu();
        else if ($$('.panel.open').length) closePanels();
        else if (state.focus) setFocus(false);
        return;
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); openSearch(); }
      else if (e.key.toLowerCase() === 'f') { setFocus(!state.focus); }
      else if (e.key.toLowerCase() === 'r') { syncFromFirst(); }
      else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
        // The digit is the number of charts, so 9 gives nine.
        const hit = LAYOUTS.find(l => l.key === e.key);
        if (hit) setLayout(hit.id);
      } else if (e.key.toLowerCase() === 'i') { openStudies(); }
      else if (e.key.toLowerCase() === 'w') { if (openPanel('panel-watchlist')) renderWatchlist(); }
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
    paintStudiesCount();
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
