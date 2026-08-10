/* ═══════════════════════════════════════════════════════════════════════
   APP — chart cells, indicator registry, panels, wiring
   ───────────────────────────────────────────────────────────────────────
   Structure: every indicator is a row in one registry table (id, params,
   compute, plots) instead of parallel switch statements in three places.
   Adding an indicator means adding one entry.

   Performance notes, since the old build stuttered on crosshair move:
     • bar lookup is a Map, not Array.find, so hovering is O(1) per frame
     • readouts write textContent on cached nodes; nothing rebuilds innerHTML
       during a mousemove
     • crosshair and resize work is coalesced into one requestAnimationFrame
     • one shared poll timer serves every cell, deduplicated by symbol,
       rather than an interval per chart
   ═══════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const LC = () => window.LightweightCharts;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Deliberately excludes the up/down green and red. If an indicator line can
  // show up in the same green as a rising candle, the colour stops meaning
  // direction. Indicators that genuinely encode direction (Supertrend, PSAR,
  // Aroon, Elder Ray) opt into those two colours explicitly.
  const PALETTE = ['#4B9BE8', '#E8B34A', '#C98BDB', '#41C9C9', '#E8834A',
                   '#7FC4E8', '#B3D14A', '#E06BA8', '#9B8BE8', '#D9A441'];
  const UP = '#2EBD85', DOWN = '#F0616D', DIM = '#7C8AA5';

  /* ══ State ═══════════════════════════════════════════════════════ */
  const state = {
    layout: '1',
    active: 0,
    cells: [],
    prePost: false,
    seriesType: 'candles',
    dividendAdjusted: false,
    reconcile: true,
    profile: null,
  };

  const STORE = {
    key: k => `tc:${state.profile || 'default'}:${k}`,
    get(k, fallback) {
      try { const v = localStorage.getItem(STORE.key(k)); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(STORE.key(k), JSON.stringify(v)); } catch {} },
  };

  /* ══ Indicator registry ══════════════════════════════════════════
     `compute` receives (bars, params, ctx) and returns plot descriptors.
     ctx carries the session/period keys so session-anchored indicators do
     not have to rediscover them. Values are plain arrays aligned to bars;
     nulls become chart gaps rather than being dropped, so a line never
     jumps across a warm-up period.                                        */
  const num = (id, label, def, min = 1, max = 5000) => ({ id, label, type: 'number', def, min, max });
  const src = (def = 'close') => ({ id: 'source', label: 'Source', type: 'select', def,
    options: ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'] });

  const line = (values, o = {}) => ({ kind: 'line', values, ...o });
  const hist = (values, o = {}) => ({ kind: 'hist', values, ...o });
  // Histograms whose sign *is* the signal earn the direction colours.
  const signColors = vals => vals.map(v => v == null ? undefined
    : v >= 0 ? 'rgba(46,189,133,.65)' : 'rgba(240,97,109,.6)');

  const IND = [
    // ── Moving averages ──────────────────────────────────────────
    { id: 'sma', name: 'SMA', group: 'Moving averages', desc: 'Simple moving average', overlay: true,
      params: [num('length', 'Length', 20), src()],
      compute: (b, p) => [line(TA.sma(TA.source(b, p.source), p.length))] },
    { id: 'ema', name: 'EMA', group: 'Moving averages', desc: 'Exponential moving average', overlay: true,
      params: [num('length', 'Length', 20), src()],
      compute: (b, p) => [line(TA.ema(TA.source(b, p.source), p.length))] },
    { id: 'wma', name: 'WMA', group: 'Moving averages', desc: 'Weighted moving average', overlay: true,
      params: [num('length', 'Length', 20), src()],
      compute: (b, p) => [line(TA.wma(TA.source(b, p.source), p.length))] },
    { id: 'dema', name: 'DEMA', group: 'Moving averages', desc: 'Double exponential MA', overlay: true,
      params: [num('length', 'Length', 20), src()],
      compute: (b, p) => [line(TA.dema(TA.source(b, p.source), p.length))] },
    { id: 'tema', name: 'TEMA', group: 'Moving averages', desc: 'Triple exponential MA', overlay: true,
      params: [num('length', 'Length', 20), src()],
      compute: (b, p) => [line(TA.tema(TA.source(b, p.source), p.length))] },
    { id: 'hma', name: 'Hull MA', group: 'Moving averages', desc: 'Hull moving average', overlay: true,
      params: [num('length', 'Length', 20), src()],
      compute: (b, p) => [line(TA.hma(TA.source(b, p.source), p.length))] },
    { id: 'zlema', name: 'ZLEMA', group: 'Moving averages', desc: 'Zero-lag exponential MA', overlay: true,
      params: [num('length', 'Length', 20), src()],
      compute: (b, p) => [line(TA.zlema(TA.source(b, p.source), p.length))] },
    { id: 'alma', name: 'ALMA', group: 'Moving averages', desc: 'Arnaud Legoux moving average', overlay: true,
      params: [num('length', 'Length', 20), { id: 'offset', label: 'Offset', type: 'number', def: 0.85, min: 0, max: 1, step: 0.05 },
               { id: 'sigma', label: 'Sigma', type: 'number', def: 6, min: 1, max: 20 }, src()],
      compute: (b, p) => [line(TA.alma(TA.source(b, p.source), p.length, p.offset, p.sigma))] },
    { id: 'vwma', name: 'VWMA', group: 'Moving averages', desc: 'Volume-weighted moving average', overlay: true,
      params: [num('length', 'Length', 20)],
      compute: (b, p) => [line(TA.vwma(b, p.length))] },

    // ── Bands and channels ───────────────────────────────────────
    { id: 'bb', name: 'Bollinger', group: 'Bands', desc: 'Bollinger Bands', overlay: true,
      params: [num('length', 'Length', 20), { id: 'mult', label: 'Std dev', type: 'number', def: 2, min: 0.1, max: 10, step: 0.1 }, src()],
      compute: (b, p) => { const r = TA.bollinger(b, p.length, p.mult, p.source);
        return [line(r.upper, { dashed: true }), line(r.mid), line(r.lower, { dashed: true, fillTo: 0 })]; } },
    { id: 'keltner', name: 'Keltner', group: 'Bands', desc: 'Keltner channel', overlay: true,
      params: [num('length', 'Length', 20), { id: 'mult', label: 'Multiplier', type: 'number', def: 2, min: 0.1, max: 10, step: 0.1 }],
      compute: (b, p) => { const r = TA.keltner(b, p.length, p.mult);
        return [line(r.upper, { dashed: true }), line(r.mid), line(r.lower, { dashed: true })]; } },
    { id: 'donchian', name: 'Donchian', group: 'Bands', desc: 'Donchian channel', overlay: true,
      params: [num('length', 'Length', 20)],
      compute: (b, p) => { const r = TA.donchian(b, p.length);
        return [line(r.upper, { dashed: true }), line(r.mid, { width: 1 }), line(r.lower, { dashed: true })]; } },
    { id: 'envelope', name: 'Envelope', group: 'Bands', desc: 'Moving average envelope', overlay: true,
      params: [num('length', 'Length', 20), { id: 'pct', label: 'Percent', type: 'number', def: 2.5, min: 0.1, max: 50, step: 0.1 }],
      compute: (b, p) => { const r = TA.envelope(b, p.length, p.pct);
        return [line(r.upper, { dashed: true }), line(r.mid), line(r.lower, { dashed: true })]; } },

    // ── Trend overlays ───────────────────────────────────────────
    { id: 'vwap', name: 'VWAP', group: 'Trend', desc: 'Session-anchored volume-weighted average price', overlay: true,
      params: [],
      compute: (b, p, ctx) => [line(TA.vwap(b, ctx.sessionKey), { width: 2 })] },
    { id: 'psar', name: 'Parabolic SAR', group: 'Trend', desc: "Wilder's stop and reverse", overlay: true,
      params: [{ id: 'step', label: 'Step', type: 'number', def: 0.02, min: 0.001, max: 1, step: 0.001 },
               { id: 'max', label: 'Max step', type: 'number', def: 0.2, min: 0.01, max: 1, step: 0.01 }],
      compute: (b, p) => {
        const pts = TA.psar(b, p.step, p.max);
        return [
          { kind: 'dots', values: pts.map(x => x.rising ? x.value : null), color: UP },
          { kind: 'dots', values: pts.map(x => x.rising ? null : x.value), color: DOWN },
        ];
      } },
    { id: 'supertrend', name: 'Supertrend', group: 'Trend', desc: 'ATR trailing stop', overlay: true,
      params: [num('length', 'ATR length', 10), { id: 'mult', label: 'Multiplier', type: 'number', def: 3, min: 0.1, max: 20, step: 0.1 }],
      compute: (b, p) => {
        const pts = TA.supertrend(b, p.length, p.mult);
        return [
          line(pts.map(x => x.trend === 1 ? x.value : null), { color: UP, width: 2 }),
          line(pts.map(x => x.trend === -1 ? x.value : null), { color: DOWN, width: 2 }),
        ];
      } },
    { id: 'ichimoku', name: 'Ichimoku', group: 'Trend', desc: 'Ichimoku cloud, correctly displaced', overlay: true,
      params: [num('tenkan', 'Tenkan', 9), num('kijun', 'Kijun', 26), num('senkou', 'Senkou B', 52)],
      compute: (b, p) => {
        const r = TA.ichimoku(b, p.tenkan, p.kijun, p.senkou);
        return [
          line(r.tenkan, { color: '#4B9BE8', title: 'Tenkan' }),
          line(r.kijun, { color: '#F0616D', title: 'Kijun' }),
          line(r.senkouA, { color: 'rgba(46,189,133,.55)', width: 1, shift: r.displacement, title: 'Senkou A' }),
          line(r.senkouB, { color: 'rgba(240,97,109,.55)', width: 1, shift: r.displacement, title: 'Senkou B' }),
          line(r.chikou, { color: '#7C8AA5', width: 1, shift: -r.displacement, title: 'Chikou' }),
        ];
      } },
    { id: 'pivots', name: 'Pivot points', group: 'Trend', desc: 'Floor-trader pivots from the previous period', overlay: true,
      params: [],
      compute: (b, p, ctx) => {
        const pv = TA.pivotPoints(b, ctx.periodKey);
        const pick = k => pv.map(x => x ? x[k] : null);
        return [
          line(pick('pp'), { color: '#E8B34A', width: 1.5, title: 'P' }),
          line(pick('r1'), { color: 'rgba(240,97,109,.7)', width: 1, dashed: true, title: 'R1' }),
          line(pick('r2'), { color: 'rgba(240,97,109,.5)', width: 1, dashed: true, title: 'R2' }),
          line(pick('r3'), { color: 'rgba(240,97,109,.35)', width: 1, dashed: true, title: 'R3' }),
          line(pick('s1'), { color: 'rgba(46,189,133,.7)', width: 1, dashed: true, title: 'S1' }),
          line(pick('s2'), { color: 'rgba(46,189,133,.5)', width: 1, dashed: true, title: 'S2' }),
          line(pick('s3'), { color: 'rgba(46,189,133,.35)', width: 1, dashed: true, title: 'S3' }),
        ];
      } },

    // ── Oscillators ──────────────────────────────────────────────
    { id: 'rsi', name: 'RSI', group: 'Oscillators', desc: 'Relative strength index', paneHeight: 90,
      params: [num('length', 'Length', 14), src()],
      levels: [70, 50, 30], range: [0, 100],
      compute: (b, p) => [line(TA.rsi(TA.source(b, p.source), p.length))] },
    { id: 'macd', name: 'MACD', group: 'Oscillators', desc: 'Moving average convergence divergence', paneHeight: 100,
      params: [num('fast', 'Fast', 12), num('slow', 'Slow', 26), num('signal', 'Signal', 9), src()],
      levels: [0],
      compute: (b, p) => { const r = TA.macd(TA.source(b, p.source), p.fast, p.slow, p.signal);
        return [hist(r.hist, { title: 'Hist', perBarColor: signColors(r.hist) }),
                line(r.line, { title: 'MACD' }), line(r.signal, { color: DOWN, width: 1, title: 'Signal' })]; } },
    { id: 'stoch', name: 'Stochastic', group: 'Oscillators', desc: 'Stochastic oscillator', paneHeight: 90,
      params: [num('k', '%K length', 14), num('smooth', '%K smoothing', 1), num('d', '%D length', 3)],
      levels: [80, 20], range: [0, 100],
      compute: (b, p) => { const r = TA.stoch(b, p.k, p.d, p.smooth);
        return [line(r.k, { title: '%K' }), line(r.d, { color: DOWN, width: 1, title: '%D' })]; } },
    { id: 'stochrsi', name: 'Stoch RSI', group: 'Oscillators', desc: 'Stochastic of RSI', paneHeight: 90,
      params: [num('rsiLength', 'RSI length', 14), num('stochLength', 'Stoch length', 14), num('k', '%K smoothing', 3), num('d', '%D smoothing', 3)],
      levels: [80, 20], range: [0, 100],
      compute: (b, p) => { const r = TA.stochRsi(TA.col(b, 'close'), p.rsiLength, p.stochLength, p.k, p.d);
        return [line(r.k, { title: '%K' }), line(r.d, { color: DOWN, width: 1, title: '%D' })]; } },
    { id: 'cci', name: 'CCI', group: 'Oscillators', desc: 'Commodity channel index', paneHeight: 90,
      params: [num('length', 'Length', 20)], levels: [100, 0, -100],
      compute: (b, p) => [line(TA.cci(b, p.length))] },
    { id: 'willr', name: 'Williams %R', group: 'Oscillators', desc: 'Williams percent range', paneHeight: 90,
      params: [num('length', 'Length', 14)], levels: [-20, -80], range: [-100, 0],
      compute: (b, p) => [line(TA.williamsR(b, p.length))] },
    { id: 'adx', name: 'ADX / DMI', group: 'Oscillators', desc: "Wilder's directional movement", paneHeight: 90,
      params: [num('length', 'Length', 14)], levels: [25],
      compute: (b, p) => { const r = TA.adx(b, p.length);
        return [line(r.adx, { width: 2, title: 'ADX' }), line(r.plusDI, { color: UP, width: 1, title: '+DI' }), line(r.minusDI, { color: DOWN, width: 1, title: '-DI' })]; } },
    { id: 'uo', name: 'Ultimate osc', group: 'Oscillators', desc: 'Ultimate oscillator', paneHeight: 90,
      params: [num('fast', 'Fast', 7), num('mid', 'Mid', 14), num('slow', 'Slow', 28)], levels: [70, 30], range: [0, 100],
      compute: (b, p) => [line(TA.ultimateOsc(b, p.fast, p.mid, p.slow))] },
    { id: 'ppo', name: 'PPO', group: 'Oscillators', desc: 'Percentage price oscillator', paneHeight: 90,
      params: [num('fast', 'Fast', 12), num('slow', 'Slow', 26), num('signal', 'Signal', 9)], levels: [0],
      compute: (b, p) => { const r = TA.ppo(TA.col(b, 'close'), p.fast, p.slow, p.signal);
        return [hist(r.hist, { perBarColor: signColors(r.hist) }), line(r.line), line(r.signal, { color: DOWN, width: 1 })]; } },
    { id: 'trix', name: 'TRIX', group: 'Oscillators', desc: 'Triple-smoothed rate of change', paneHeight: 80,
      params: [num('length', 'Length', 18)], levels: [0],
      compute: (b, p) => [line(TA.trix(TA.col(b, 'close'), p.length))] },
    { id: 'roc', name: 'ROC', group: 'Oscillators', desc: 'Rate of change', paneHeight: 80,
      params: [num('length', 'Length', 12), src()], levels: [0],
      compute: (b, p) => [line(TA.roc(TA.source(b, p.source), p.length))] },
    { id: 'mom', name: 'Momentum', group: 'Oscillators', desc: 'Price momentum', paneHeight: 80,
      params: [num('length', 'Length', 10), src()], levels: [0],
      compute: (b, p) => [line(TA.momentum(TA.source(b, p.source), p.length))] },
    { id: 'dpo', name: 'DPO', group: 'Oscillators', desc: 'Detrended price oscillator', paneHeight: 80,
      params: [num('length', 'Length', 20)], levels: [0],
      compute: (b, p) => [line(TA.dpo(TA.col(b, 'close'), p.length))] },
    { id: 'aroon', name: 'Aroon', group: 'Oscillators', desc: 'Aroon up and down', paneHeight: 90,
      params: [num('length', 'Length', 25)], levels: [70, 30], range: [0, 100],
      compute: (b, p) => { const r = TA.aroon(b, p.length);
        return [line(r.up, { color: UP, title: 'Up' }), line(r.down, { color: DOWN, title: 'Down' })]; } },
    { id: 'elderray', name: 'Elder Ray', group: 'Oscillators', desc: 'Bull and bear power', paneHeight: 90,
      params: [num('length', 'Length', 13)], levels: [0],
      compute: (b, p) => { const r = TA.elderRay(b, p.length);
        return [hist(r.bull, { color: UP, title: 'Bull' }), hist(r.bear, { color: DOWN, title: 'Bear' })]; } },

    // ── Volatility ───────────────────────────────────────────────
    { id: 'atr', name: 'ATR', group: 'Volatility', desc: "Average true range (Wilder)", paneHeight: 80,
      params: [num('length', 'Length', 14)],
      compute: (b, p) => [line(TA.atr(b, p.length))] },
    { id: 'stddev', name: 'Std deviation', group: 'Volatility', desc: 'Rolling standard deviation', paneHeight: 80,
      params: [num('length', 'Length', 20), src()],
      compute: (b, p) => [line(TA.stdev(TA.source(b, p.source), p.length))] },
    { id: 'chop', name: 'Choppiness', group: 'Volatility', desc: 'Choppiness index', paneHeight: 80,
      params: [num('length', 'Length', 14)], levels: [61.8, 38.2], range: [0, 100],
      compute: (b, p) => [line(TA.chop(b, p.length))] },

    // ── Volume ───────────────────────────────────────────────────
    { id: 'volume', name: 'Volume', group: 'Volume', desc: 'Traded volume', paneHeight: 70,
      params: [],
      compute: (b) => [hist(b.map(x => x.volume), { perBarColor: b.map(x => x.close >= x.open ? 'rgba(46,189,133,.5)' : 'rgba(240,97,109,.45)'), title: 'Vol' })] },
    { id: 'obv', name: 'OBV', group: 'Volume', desc: 'On-balance volume', paneHeight: 80,
      params: [], compute: (b) => [line(TA.obv(b))] },
    { id: 'cmf', name: 'CMF', group: 'Volume', desc: 'Chaikin money flow', paneHeight: 80,
      params: [num('length', 'Length', 20)], levels: [0],
      compute: (b, p) => [line(TA.cmf(b, p.length))] },
    { id: 'mfi', name: 'MFI', group: 'Volume', desc: 'Money flow index', paneHeight: 90,
      params: [num('length', 'Length', 14)], levels: [80, 20], range: [0, 100],
      compute: (b, p) => [line(TA.mfi(b, p.length))] },
    { id: 'vpt', name: 'VPT', group: 'Volume', desc: 'Volume price trend', paneHeight: 80,
      params: [], compute: (b) => [line(TA.vpt(b))] },
  ];
  const INDBY = Object.fromEntries(IND.map(d => [d.id, d]));

  const defaults = def => Object.fromEntries((def.params || []).map(p => [p.id, p.def]));
  const indLabel = (def, params) => {
    const nums = (def.params || []).filter(p => p.type === 'number').map(p => params[p.id]);
    return nums.length ? `${def.name} ${nums.join(' ')}` : def.name;
  };

  /* ══ Chart series types ══════════════════════════════════════════ */
  const SERIES_TYPES = [
    { id: 'candles', name: 'Candles' },
    { id: 'hollow', name: 'Hollow candles' },
    { id: 'bars', name: 'Bars' },
    { id: 'heikin', name: 'Heikin-Ashi' },
    { id: 'line', name: 'Line' },
    { id: 'step', name: 'Step line' },
    { id: 'area', name: 'Area' },
    { id: 'baseline', name: 'Baseline' },
    { id: 'renko', name: 'Renko' },
    { id: 'linebreak', name: 'Line break' },
  ];

  /* ══ Chart construction ══════════════════════════════════════════ */
  const chartOptions = () => ({
    layout: { background: { type: 'solid', color: '#0B0E14' }, textColor: '#7C8AA5', fontSize: 11,
              fontFamily: getComputedStyle(document.body).getPropertyValue('--mono') },
    grid: { vertLines: { color: '#151C28' }, horzLines: { color: '#151C28' } },
    crosshair: {
      mode: LC().CrosshairMode.Normal,
      vertLine: { color: '#3A4557', width: 1, style: LC().LineStyle.Dashed, labelBackgroundColor: '#1A2130' },
      horzLine: { color: '#3A4557', width: 1, style: LC().LineStyle.Dashed, labelBackgroundColor: '#1A2130' },
    },
    rightPriceScale: { borderColor: '#212A3A', scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: '#212A3A', timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8 },
    handleScroll: { vertTouchDrag: false },
    autoSize: true,
  });

  const paneOptions = (range) => ({
    // Each oscillator is its own chart instance (v4 has no real panes), so the
    // library would stamp its attribution logo onto every one of them. Keep it
    // on the price chart, which satisfies attribution once per cell.
    layout: { background: { type: 'solid', color: '#0B0E14' }, textColor: '#4C5A73', fontSize: 10,
              attributionLogo: false,
              fontFamily: getComputedStyle(document.body).getPropertyValue('--mono') },
    grid: { vertLines: { color: '#121822' }, horzLines: { color: '#121822' } },
    crosshair: {
      mode: LC().CrosshairMode.Normal,
      vertLine: { color: '#3A4557', width: 1, style: LC().LineStyle.Dashed, labelVisible: false },
      horzLine: { visible: false, labelVisible: false },
    },
    rightPriceScale: {
      borderColor: '#212A3A', scaleMargins: { top: 0.14, bottom: 0.08 },
      autoScale: !range,
    },
    timeScale: { visible: false, borderVisible: false },
    handleScroll: false, handleScale: false, autoSize: true,
  });

  function priceFormat(price) {
    const d = DATA.decimalsFor(price);
    return { type: 'price', precision: d, minMove: Math.pow(10, -d) };
  }

  // Builds the main price series for the chosen chart type. Renko and line
  // break re-time their bars, so they return their own data.
  function buildMainSeries(chart, type, bars) {
    const common = { priceLineColor: '#3A4557', priceLineStyle: LC().LineStyle.Dotted };
    const candle = { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
                     wickUpColor: UP, wickDownColor: DOWN, ...common };
    switch (type) {
      case 'hollow': {
        const s = chart.addCandlestickSeries({ ...candle, upColor: 'transparent', wickUpColor: UP });
        s.setData(bars); return s;
      }
      case 'bars': {
        const s = chart.addBarSeries({ upColor: UP, downColor: DOWN, ...common });
        s.setData(bars); return s;
      }
      case 'heikin': {
        const s = chart.addCandlestickSeries(candle);
        s.setData(TA.heikinAshi(bars)); return s;
      }
      case 'renko': {
        const s = chart.addCandlestickSeries(candle);
        const box = (TA.atr(bars, 14).filter(Boolean).pop()) || (bars[bars.length - 1].close * 0.005);
        s.setData(TA.renko(bars, box)); return s;
      }
      case 'linebreak': {
        const s = chart.addCandlestickSeries(candle);
        s.setData(TA.lineBreak(bars, 3)); return s;
      }
      case 'line': {
        const s = chart.addLineSeries({ color: '#4B9BE8', lineWidth: 2, ...common });
        s.setData(bars.map(b => ({ time: b.time, value: b.close }))); return s;
      }
      case 'step': {
        const s = chart.addLineSeries({ color: '#4B9BE8', lineWidth: 2, lineType: LC().LineType.WithSteps, ...common });
        s.setData(bars.map(b => ({ time: b.time, value: b.close }))); return s;
      }
      case 'area': {
        const s = chart.addAreaSeries({ lineColor: '#4B9BE8', topColor: 'rgba(75,155,232,.28)', bottomColor: 'rgba(75,155,232,0)', lineWidth: 2, ...common });
        s.setData(bars.map(b => ({ time: b.time, value: b.close }))); return s;
      }
      case 'baseline': {
        const base = bars.length ? bars[0].close : 0;
        const s = chart.addBaselineSeries({
          baseValue: { type: 'price', price: base },
          topLineColor: UP, topFillColor1: 'rgba(46,189,133,.26)', topFillColor2: 'rgba(46,189,133,0)',
          bottomLineColor: DOWN, bottomFillColor1: 'rgba(240,97,109,0)', bottomFillColor2: 'rgba(240,97,109,.26)',
          lineWidth: 2, ...common,
        });
        s.setData(bars.map(b => ({ time: b.time, value: b.close }))); return s;
      }
      default: {
        const s = chart.addCandlestickSeries(candle);
        s.setData(bars); return s;
      }
    }
  }

  const isValueSeries = t => ['line', 'step', 'area', 'baseline'].includes(t);

  /* ══ Cell ════════════════════════════════════════════════════════ */
  function createCell(idx) {
    const el = document.createElement('section');
    el.className = 'cell';
    el.dataset.idx = idx;
    el.innerHTML = `
      <div class="cell-bar">
        <input class="sym-input" spellcheck="false" aria-label="Symbol">
        <div class="sep"></div>
        <div class="tf-group">${DATA.TIMEFRAMES.map(t =>
          `<button class="tf-btn" data-tf="${t.id}">${t.label}</button>`).join('')}</div>
        <div class="spacer"></div>
        <span class="chg-badge" hidden></span>
        <span class="last-price">—</span>
      </div>
      <div class="ribbon" hidden>
        <div class="ribbon-seg pre"></div><div class="ribbon-seg reg"></div><div class="ribbon-seg post"></div>
        <div class="ribbon-done"></div><div class="ribbon-now"></div>
      </div>
      <div class="panes">
        <div class="pane-main"></div>
      </div>
      <div class="readout">
        <div class="ohlc">
          <span><b>O</b><span class="v o">—</span></span><span><b>H</b><span class="v h">—</span></span>
          <span><b>L</b><span class="v l">—</span></span><span><b>C</b><span class="v c">—</span></span>
          <span style="color:var(--dim)"><b>V</b><span class="vol">—</span></span>
        </div>
        <div class="legend"></div>
      </div>
      <div class="cell-state"><div class="spinner"></div><span class="msg">Loading</span></div>`;

    const cell = {
      idx, el,
      chart: null, series: null, bars: [], byTime: new Map(), meta: null,
      symbol: '', tf: '1d', indicators: [], drawings: [],
      lastPrice: null, hoverTime: null, destroyed: false,
      els: {
        bar: $('.cell-bar', el),
        sym: $('.sym-input', el),
        price: $('.last-price', el),
        chg: $('.chg-badge', el),
        panes: $('.panes', el),
        main: $('.pane-main', el),
        ribbon: $('.ribbon', el),
        ribbonPre: $('.ribbon-seg.pre', el), ribbonReg: $('.ribbon-seg.reg', el),
        ribbonPost: $('.ribbon-seg.post', el), ribbonDone: $('.ribbon-done', el), ribbonNow: $('.ribbon-now', el),
        legend: $('.legend', el),
        ohlc: $('.ohlc', el),
        o: $('.ohlc .o', el), h: $('.ohlc .h', el), l: $('.ohlc .l', el), c: $('.ohlc .c', el), vol: $('.ohlc .vol', el),
        state: $('.cell-state', el), stateMsg: $('.cell-state .msg', el),
      },
    };

    cell.chart = LC().createChart(cell.els.main, chartOptions());
    wireCell(cell);
    return cell;
  }

  function wireCell(cell) {
    const { els } = cell;

    els.sym.addEventListener('keydown', e => {
      if (e.key === 'Enter') { loadCell(cell, els.sym.value.trim().toUpperCase(), cell.tf); els.sym.blur(); }
      if (e.key === 'Escape') { els.sym.value = cell.symbol; els.sym.blur(); }
    });
    els.sym.addEventListener('focus', () => els.sym.select());

    els.bar.addEventListener('click', e => {
      const tf = e.target.closest('.tf-btn');
      if (tf) loadCell(cell, cell.symbol, tf.dataset.tf);
    });

    cell.el.addEventListener('pointerdown', () => setActive(cell.idx), true);

    // One rAF per frame for the whole hover update, no matter how many
    // crosshair events the library emits.
    let pending = null;
    cell.chart.subscribeCrosshairMove(param => {
      pending = param;
      if (cell._raf) return;
      cell._raf = requestAnimationFrame(() => {
        cell._raf = null;
        const p = pending;
        const bar = p && p.time != null ? cell.byTime.get(p.time) : null;
        cell.hoverTime = bar ? p.time : null;
        renderReadout(cell, bar || cell.bars[cell.bars.length - 1]);
        syncPanes(cell, p);
      });
    });

    cell.chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (!r) return;
      for (const ind of cell.indicators)
        if (ind.paneChart) { try { ind.paneChart.timeScale().setVisibleLogicalRange(r); } catch {} }
    });

    cell.chart.subscribeClick(param => handleDrawClick(cell, param));
  }

  function destroyCell(cell) {
    cell.destroyed = true;
    for (const ind of cell.indicators) if (ind.paneChart) { try { ind.paneChart.remove(); } catch {} }
    try { cell.chart.remove(); } catch {}
    cell.el.remove();
  }

  /* ══ Readout ═════════════════════════════════════════════════════
     Writes text into cached nodes. Nothing here allocates a string that
     the parser has to re-read, which is what made the old readout stutter
     while the mouse moved.                                               */
  function renderReadout(cell, bar) {
    if (!bar) return;
    const { els } = cell;
    const d = DATA.decimalsFor(bar.close);
    const up = bar.close >= bar.open;
    els.ohlc.className = 'ohlc ' + (up ? 'up' : 'down');
    els.o.textContent = bar.open.toFixed(d);
    els.h.textContent = bar.high.toFixed(d);
    els.l.textContent = bar.low.toFixed(d);
    els.c.textContent = bar.close.toFixed(d);
    els.vol.textContent = DATA.fmtVolume(bar.volume);
    renderLegendValues(cell, bar.time);
  }

  function renderPrice(cell, price, flash) {
    const { els, meta } = cell;
    if (price == null) return;
    const d = DATA.decimalsFor(price);
    els.price.textContent = price.toFixed(d);
    const prev = meta?.previousClose;
    if (prev > 0) {
      const chg = price - prev, pct = chg / prev * 100;
      els.chg.hidden = false;
      els.chg.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(d)} (${chg >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      els.chg.className = 'chg-badge ' + (chg >= 0 ? 'up' : 'down');
      els.price.className = 'last-price ' + (chg >= 0 ? 'up' : 'down');
    } else {
      els.chg.hidden = true;
      els.price.className = 'last-price';
    }
    if (flash && cell.lastPrice != null && price !== cell.lastPrice) {
      const dir = price > cell.lastPrice ? 'flash-up' : 'flash-down';
      els.price.classList.add(dir);
      setTimeout(() => els.price.classList.remove(dir), 220);
    }
    cell.lastPrice = price;
  }

  /* ══ Session ribbon ══════════════════════════════════════════════
     Draws the trading day to scale: pre-market, regular hours, after-hours,
     the portion already elapsed, and a playhead at now. For a gapper the
     04:00–09:30 block is the part that matters, so it keeps its real width
     instead of being collapsed to a label.                                */
  function renderRibbon(cell, nowSec = Date.now() / 1000) {
    const { els, meta } = cell;
    // Only meaningful intraday. On a daily bar the session *is* the candle, so
    // the ribbon would just be a decorative stripe.
    const useful = meta && !meta.is24h && DATA.isIntraday(cell.tf)
      && meta.sessionStart != null && meta.sessionEnd != null;
    if (!useful) { els.ribbon.hidden = true; return; }

    els.ribbon.hidden = false;
    const preStart = meta.sessionStart - 5.5 * 3600;      // 04:00 exchange-local
    const postEnd = meta.sessionEnd + 4 * 3600;           // 20:00 exchange-local
    const span = postEnd - preStart;
    const pct = t => clamp((t - preStart) / span * 100, 0, 100);
    const regL = pct(meta.sessionStart), regR = pct(meta.sessionEnd);

    els.ribbonPre.style.cssText = `left:0%;width:${regL}%`;
    els.ribbonReg.style.cssText = `left:${regL}%;width:${regR - regL}%`;
    els.ribbonPost.style.cssText = `left:${regR}%;width:${100 - regR}%`;
    const p = pct(nowSec);
    const inWindow = nowSec >= preStart && nowSec <= postEnd;
    els.ribbonDone.style.width = inWindow ? p + '%' : '0%';
    els.ribbonNow.style.left = p + '%';
    els.ribbonNow.style.display = inWindow ? '' : 'none';
  }

  /* ══ Indicators on a cell ════════════════════════════════════════ */
  function makePlotData(bars, values, shift = 0) {
    // A null becomes a whitespace point: the renderer leaves a gap instead of
    // drawing a straight line across a warm-up period or a trend flip.
    const out = [];
    const step = bars.length > 1 ? medianStep(bars) : 86400;
    for (let i = 0; i < values.length && i < bars.length; i++) {
      const t = shift ? bars[i].time + shift * step : bars[i].time;
      const v = values[i];
      out.push(v == null || !Number.isFinite(v) ? { time: t } : { time: t, value: v });
    }
    return out;
  }
  let _stepCache = new WeakMap();
  function medianStep(bars) {
    let s = _stepCache.get(bars);
    if (s) return s;
    const gaps = [];
    for (let i = 1; i < Math.min(bars.length, 60); i++) gaps.push(bars[i].time - bars[i - 1].time);
    gaps.sort((a, b) => a - b);
    s = gaps[Math.floor(gaps.length / 2)] || 86400;
    _stepCache.set(bars, s);
    return s;
  }

  function addIndicator(cell, defId, params, color, opts = {}) {
    const def = INDBY[defId];
    if (!def) return null;
    if (!cell.bars.length) { toast('Load a symbol first', 'error'); return null; }
    const ind = {
      uid: 'i' + Math.random().toString(36).slice(2, 9),
      defId, def,
      params: { ...defaults(def), ...params },
      color: color || PALETTE[cell.indicators.length % PALETTE.length],
      plots: [], paneEl: null, paneChart: null, gripEl: null, titleEl: null,
    };
    cell.indicators.push(ind);
    buildIndicator(cell, ind);
    if (!opts.silent) { saveLayout(); refreshIndicatorPanel(); }
    renderLegend(cell);
    return ind;
  }

  function buildIndicator(cell, ind) {
    const { def } = ind;
    const ctx = {
      sessionKey: DATA.sessionKey,
      periodKey: DATA.periodKeyFor(cell.tf),
    };
    let descriptors;
    try {
      descriptors = def.compute(cell.bars, ind.params, ctx) || [];
    } catch (e) {
      toast(`${def.name} failed: ${e.message}`, 'error');
      descriptors = [];
    }

    let chart = cell.chart;
    if (!def.overlay) {
      if (!ind.paneEl) {
        const grip = document.createElement('div');
        grip.className = 'pane-grip';
        const pane = document.createElement('div');
        pane.className = 'pane-osc';
        pane.style.height = (def.paneHeight || 84) + 'px';
        pane.innerHTML = `<div class="pane-osc-title"><span class="nm"></span><span class="v"></span></div>
          <button class="pane-close" title="Remove"><svg viewBox="0 0 16 16"><use href="#i-close"/></svg></button>`;
        cell.els.panes.append(grip, pane);
        ind.gripEl = grip; ind.paneEl = pane;
        ind.titleEl = $('.pane-osc-title .nm', pane);
        ind.valueEl = $('.pane-osc-title .v', pane);
        $('.pane-close', pane).addEventListener('click', () => removeIndicator(cell, ind.uid));
        addGrip(grip, pane, () => ind.paneChart);
        ind.paneChart = LC().createChart(pane, paneOptions(def.range));
        // Keep the pane locked to the main chart's visible range.
        const r = cell.chart.timeScale().getVisibleLogicalRange();
        if (r) try { ind.paneChart.timeScale().setVisibleLogicalRange(r); } catch {}
      }
      ind.titleEl.textContent = indLabel(def, ind.params);
      chart = ind.paneChart;
    }

    // Rebuild series (params may have changed the plot count).
    for (const p of ind.plots) { try { (p.chart || chart).removeSeries(p.series); } catch {} }
    ind.plots = [];

    descriptors.forEach((d, i) => {
      const color = d.color || (i === 0 ? ind.color : shade(ind.color, 0.55));
      let s;
      if (d.kind === 'hist') {
        s = chart.addHistogramSeries({
          color, priceLineVisible: false, lastValueVisible: false,
          priceFormat: def.id === 'volume' ? { type: 'volume' } : undefined,
        });
      } else if (d.kind === 'dots') {
        s = chart.addLineSeries({
          color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.6,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
      } else {
        s = chart.addLineSeries({
          color, lineWidth: d.width || 1.5,
          lineStyle: d.dashed ? LC().LineStyle.Dashed : LC().LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
      }
      const data = makePlotData(cell.bars, d.values, d.shift || 0);
      if (d.perBarColor) data.forEach((pt, j) => { if (pt.value != null) pt.color = d.perBarColor[j]; });
      s.setData(data);
      ind.plots.push({ series: s, chart, values: d.values, title: d.title, color, shift: d.shift || 0 });
    });

    if (def.levels && ind.plots[0]) {
      for (const lv of def.levels) {
        try {
          ind.plots[0].series.createPriceLine({
            price: lv, color: 'rgba(124,138,165,.22)', lineWidth: 1,
            lineStyle: LC().LineStyle.Dashed, axisLabelVisible: false,
          });
        } catch {}
      }
    }
    if (def.range && ind.paneChart) {
      try {
        ind.plots[0]?.series.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range[0], maxValue: def.range[1] } }) });
      } catch {}
    }
  }

  function refreshIndicators(cell) {
    for (const ind of cell.indicators) buildIndicator(cell, ind);
    renderLegend(cell);
  }

  function removeIndicator(cell, uid) {
    const i = cell.indicators.findIndex(x => x.uid === uid);
    if (i < 0) return;
    const ind = cell.indicators[i];
    for (const p of ind.plots) { try { p.chart.removeSeries(p.series); } catch {} }
    if (ind.paneChart) { try { ind.paneChart.remove(); } catch {} }
    ind.paneEl?.remove(); ind.gripEl?.remove();
    cell.indicators.splice(i, 1);
    renderLegend(cell); saveLayout(); refreshIndicatorPanel();
  }

  function shade(hex, k) {
    const m = /^#?([\da-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const r = Math.round(((n >> 16) & 255) * k + 255 * (1 - k) * 0.25);
    const g = Math.round(((n >> 8) & 255) * k + 255 * (1 - k) * 0.25);
    const b = Math.round((n & 255) * k + 255 * (1 - k) * 0.25);
    return `rgb(${r},${g},${b})`;
  }

  function renderLegend(cell) {
    const el = cell.els.legend;
    el.textContent = '';
    for (const ind of cell.indicators) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch'; sw.style.background = ind.color;
      const name = document.createElement('span');
      name.textContent = indLabel(ind.def, ind.params);
      const val = document.createElement('span');
      val.className = 'legend-val';
      const gear = document.createElement('button');
      gear.className = 'legend-btn'; gear.title = 'Settings';
      gear.innerHTML = '<svg viewBox="0 0 16 16"><use href="#i-gear"/></svg>';
      gear.addEventListener('click', e => { e.stopPropagation(); openIndicatorSettings(cell, ind); });
      const del = document.createElement('button');
      del.className = 'legend-btn'; del.title = 'Remove';
      del.innerHTML = '<svg viewBox="0 0 16 16"><use href="#i-close"/></svg>';
      del.addEventListener('click', e => { e.stopPropagation(); removeIndicator(cell, ind.uid); });
      row.append(sw, name, val, gear, del);
      el.append(row);
      ind.legendValueEl = val;
    }
    renderLegendValues(cell, cell.hoverTime);
  }

  function renderLegendValues(cell, time) {
    const idx = time != null ? cell.timeIndex?.get(time) : cell.bars.length - 1;
    const i = idx == null ? cell.bars.length - 1 : idx;
    for (const ind of cell.indicators) {
      const parts = [];
      for (const p of ind.plots) {
        const v = p.values?.[i];
        if (v != null && Number.isFinite(v)) parts.push(fmtIndicator(v));
      }
      if (ind.legendValueEl) ind.legendValueEl.textContent = parts.join('  ');
      if (ind.valueEl) ind.valueEl.textContent = parts.join('  ');
    }
  }
  const fmtIndicator = v => {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1000) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(4);
  };

  function syncPanes(cell, param) {
    if (!param || !cell.indicators.length) return;
    // Panes follow the main chart's logical range via the range subscription;
    // nothing per-frame is needed here beyond the legend, already updated.
  }

  function addGrip(grip, pane, getChart) {
    let startY = 0, startH = 0, dragging = false;
    grip.addEventListener('pointerdown', e => {
      dragging = true; startY = e.clientY; startH = pane.offsetHeight;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', e => {
      if (!dragging) return;
      pane.style.height = clamp(startH + (startY - e.clientY), 44, 400) + 'px';
    });
    grip.addEventListener('pointerup', e => {
      dragging = false;
      grip.releasePointerCapture(e.pointerId);
      saveLayout();
    });
  }

  /* ══ Loading ═════════════════════════════════════════════════════ */
  async function loadCell(cell, symbol, tf) {
    symbol = (symbol || cell.symbol || 'AAPL').toUpperCase();
    tf = tf || cell.tf;
    cell.symbol = symbol; cell.tf = tf;
    cell.els.sym.value = symbol;
    $$('.tf-btn', cell.els.bar).forEach(b => b.classList.toggle('on', b.dataset.tf === tf));
    showState(cell, 'loading', `Loading ${symbol}`);

    const token = (cell.loadToken = Symbol('load'));
    try {
      const { bars, meta } = await DATA.fetchBars(symbol, tf, {
        prePost: state.prePost,
        dividendAdjusted: state.dividendAdjusted,
        reconcile: state.reconcile,
      });
      if (cell.loadToken !== token || cell.destroyed) return;   // superseded

      cell.bars = bars;
      cell.meta = meta;
      cell.byTime = new Map(bars.map(b => [b.time, b]));
      cell.timeIndex = new Map(bars.map((b, i) => [b.time, i]));
      _stepCache = new WeakMap();

      if (cell.series) { try { cell.chart.removeSeries(cell.series); } catch {} }
      cell.series = buildMainSeries(cell.chart, state.seriesType, bars);
      cell.series.applyOptions({ priceFormat: priceFormat(bars[bars.length - 1].close) });
      cell.chart.applyOptions({
        timeScale: { secondsVisible: false, timeVisible: DATA.isIntraday(tf) },
      });
      cell.chart.timeScale().fitContent();

      refreshIndicators(cell);
      redrawDrawings(cell);
      renderReadout(cell, bars[bars.length - 1]);
      renderPrice(cell, meta.price, false);
      renderRibbon(cell);
      showState(cell, null);
      saveLayout();
      if (cell.idx === state.active) refreshNewsIfOpen();
    } catch (e) {
      if (cell.loadToken !== token || cell.destroyed) return;
      showState(cell, 'error', `${symbol}: ${e.message}`);
    }
  }

  function showState(cell, kind, msg) {
    const el = cell.els.state;
    if (!kind) { el.classList.remove('show', 'error'); return; }
    el.classList.add('show');
    el.classList.toggle('error', kind === 'error');
    $('.spinner', el).style.display = kind === 'loading' ? '' : 'none';
    cell.els.stateMsg.textContent = msg;
    let retry = $('.retry', el);
    if (kind === 'error') {
      if (!retry) {
        retry = document.createElement('button');
        retry.className = 'btn retry'; retry.textContent = 'Retry';
        retry.addEventListener('click', () => loadCell(cell, cell.symbol, cell.tf));
        el.append(retry);
      }
      retry.style.display = '';
    } else if (retry) retry.style.display = 'none';
  }

  /* ══ Live polling ════════════════════════════════════════════════
     One timer for the whole app, deduplicated by symbol. The old build ran
     an interval per chart, so six charts on the same ticker made six
     identical requests every ten seconds.                                  */
  let pollTimer = null;
  async function pollOnce() {
    const symbols = [...new Set(state.cells.filter(c => c.symbol).map(c => c.symbol))];
    if (!symbols.length) return;
    const quotes = await DATA.fetchQuotes(symbols, { concurrency: 4 });
    const bySym = new Map(quotes.map(q => [q.symbol.toUpperCase(), q]));
    const now = Date.now() / 1000;

    for (const cell of state.cells) {
      const q = bySym.get(cell.symbol.toUpperCase());
      if (!q || !cell.meta || !cell.bars.length) continue;

      // Refresh the session window so the ribbon and the open/closed gate
      // stay right across a day boundary without a full reload.
      cell.meta.sessionStart = q.sessionStart ?? cell.meta.sessionStart;
      cell.meta.sessionEnd = q.sessionEnd ?? cell.meta.sessionEnd;
      cell.meta.previousClose = q.previousClose ?? cell.meta.previousClose;
      cell.meta.price = q.price;

      const res = DATA.applyTick(cell.bars, cell.meta, q.price, now);
      if (res) {
        if (res.isNew) {
          cell.byTime.set(res.bar.time, res.bar);
          cell.timeIndex.set(res.bar.time, cell.bars.length - 1);
        }
        try {
          cell.series.update(isValueSeries(state.seriesType)
            ? { time: res.bar.time, value: res.bar.close }
            : res.bar);
        } catch {}
        if (cell.hoverTime == null) renderReadout(cell, res.bar);
        // Indicators depend on the whole series, so recompute on a new bar
        // and leave the forming bar to the cheap path.
        if (res.isNew) refreshIndicators(cell);
      }
      renderPrice(cell, q.price, true);
      renderRibbon(cell, now);
    }
    updateMarketState();
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    const tick = () => { if (!document.hidden) pollOnce().catch(() => {}); };
    pollTimer = setInterval(tick, 10000);
    tick();
  }

  function updateMarketState() {
    const cell = state.cells[state.active];
    const el = $('#market-state'), label = $('#market-label');
    if (!cell?.meta) { el.dataset.state = 'closed'; label.textContent = 'No data'; return; }
    const m = cell.meta, now = Date.now() / 1000;
    if (m.is24h) { el.dataset.state = 'open'; label.textContent = '24h market'; return; }
    if (m.sessionStart == null) { el.dataset.state = 'closed'; label.textContent = 'Closed'; return; }
    if (now >= m.sessionStart && now < m.sessionEnd) {
      el.dataset.state = 'open';
      label.textContent = 'Open · ' + countdown(cell);
    } else if (now >= m.sessionStart - 5.5 * 3600 && now < m.sessionStart) {
      el.dataset.state = 'pre'; label.textContent = 'Pre-market';
    } else if (now >= m.sessionEnd && now < m.sessionEnd + 4 * 3600) {
      el.dataset.state = 'post'; label.textContent = 'After hours';
    } else { el.dataset.state = 'closed'; label.textContent = 'Closed'; }
  }

  // Time left in the candle currently forming.
  function countdown(cell) {
    const secs = cell.meta.tfSecs;
    if (secs >= 86400) return 'daily';
    const last = cell.bars[cell.bars.length - 1];
    if (!last) return '';
    const rem = Math.max(0, Math.ceil((last.utc + secs) - Date.now() / 1000));
    const h = Math.floor(rem / 3600), m = Math.floor((rem % 3600) / 60), s = rem % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
             : `${m}:${String(s).padStart(2, '0')}`;
  }

  /* ══ Drawings ════════════════════════════════════════════════════
     Kept deliberately small: horizontal lines and a two-click trend line,
     rectangle and fib, all stored as price/time pairs so they survive a
     reload and a timeframe change.                                        */
  let tool = 'cursor', pending = null;

  function setTool(t) {
    tool = t; pending = null;
    $$('#rail .btn[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    const mode = t === 'crosshair' ? LC().CrosshairMode.Magnet : LC().CrosshairMode.Normal;
    for (const c of state.cells) c.chart.applyOptions({ crosshair: { mode } });
    document.body.style.cursor = ['trendline', 'hline', 'rect', 'fib'].includes(t) ? 'crosshair' : '';
  }

  function handleDrawClick(cell, param) {
    if (tool === 'cursor' || tool === 'crosshair' || !param.point || param.time == null) return;
    const price = cell.series.coordinateToPrice(param.point.y);
    if (price == null) return;
    if (tool === 'hline') {
      cell.drawings.push({ type: 'hline', price });
      redrawDrawings(cell); saveLayout(); return;
    }
    if (!pending) {
      pending = { cell, time: param.time, price };
      toast('Click a second point · Esc to cancel');
      return;
    }
    if (pending.cell !== cell) { pending = { cell, time: param.time, price }; return; }
    cell.drawings.push({ type: tool, t1: pending.time, p1: pending.price, t2: param.time, p2: price });
    pending = null;
    redrawDrawings(cell); saveLayout();
  }

  const FIBS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  function redrawDrawings(cell) {
    for (const s of cell._drawSeries || []) { try { cell.chart.removeSeries(s); } catch {} }
    cell._drawSeries = [];
    if (!cell.bars.length) return;
    const first = cell.bars[0].time, last = cell.bars[cell.bars.length - 1].time;

    for (const d of cell.drawings) {
      const add = (pts, color, width = 1, dashed = false) => {
        const s = cell.chart.addLineSeries({
          color, lineWidth: width, lineStyle: dashed ? LC().LineStyle.Dashed : LC().LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        s.setData(pts);
        cell._drawSeries.push(s);
      };
      if (d.type === 'hline') {
        add([{ time: first, value: d.price }, { time: last, value: d.price }], '#E8B34A', 1, true);
      } else if (d.type === 'trendline') {
        add([{ time: d.t1, value: d.p1 }, { time: d.t2, value: d.p2 }], '#4B9BE8', 1.5);
      } else if (d.type === 'rect') {
        const [ta, tb] = [Math.min(d.t1, d.t2), Math.max(d.t1, d.t2)];
        const [pa, pb] = [Math.min(d.p1, d.p2), Math.max(d.p1, d.p2)];
        add([{ time: ta, value: pa }, { time: tb, value: pa }], 'rgba(75,155,232,.75)');
        add([{ time: ta, value: pb }, { time: tb, value: pb }], 'rgba(75,155,232,.75)');
      } else if (d.type === 'fib') {
        const hi = Math.max(d.p1, d.p2), lo = Math.min(d.p1, d.p2);
        const [ta, tb] = [Math.min(d.t1, d.t2), Math.max(d.t1, d.t2)];
        FIBS.forEach((f, i) => {
          const v = hi - (hi - lo) * f;
          add([{ time: ta, value: v }, { time: tb, value: v }],
            i === 0 || i === FIBS.length - 1 ? 'rgba(232,179,74,.8)' : 'rgba(232,179,74,.4)', 1, i !== 0 && i !== FIBS.length - 1);
        });
      }
    }
  }

  /* ══ Layout ══════════════════════════════════════════════════════ */
  const LAYOUT_COUNT = { '1': 1, '2': 2, '2v': 2, '3': 3, '4': 4, '6': 6 };

  function setLayout(id, opts = {}) {
    state.layout = id;
    const want = LAYOUT_COUNT[id] || 1;
    const grid = $('#grid');
    grid.dataset.layout = id;
    $$('#layouts .btn').forEach(b => b.classList.toggle('on', b.dataset.layout === id));

    while (state.cells.length > want) destroyCell(state.cells.pop());
    while (state.cells.length < want) {
      const cell = createCell(state.cells.length);
      state.cells.push(cell);
      grid.append(cell.el);
      if (!opts.skipLoad) {
        const seed = ['AAPL', 'MSFT', 'NVDA', 'SPY', 'TSLA', 'BTC-USD'][cell.idx] || 'AAPL';
        loadCell(cell, seed, cell.tf);
      }
    }
    state.cells.forEach((c, i) => { c.idx = i; c.el.dataset.idx = i; });
    setActive(Math.min(state.active, state.cells.length - 1));
    if (!opts.skipSave) saveLayout();
  }

  function setActive(i) {
    state.active = clamp(i, 0, state.cells.length - 1);
    state.cells.forEach((c, j) => c.el.classList.toggle('active', j === state.active));
    updateMarketState();
    refreshIndicatorPanel();
  }
  const activeCell = () => state.cells[state.active];

  function saveLayout() {
    STORE.set('layout', {
      layout: state.layout, active: state.active,
      prePost: state.prePost, seriesType: state.seriesType,
      dividendAdjusted: state.dividendAdjusted, reconcile: state.reconcile,
      cells: state.cells.map(c => ({
        symbol: c.symbol, tf: c.tf,
        indicators: c.indicators.map(i => ({ defId: i.defId, params: i.params, color: i.color,
          height: i.paneEl ? i.paneEl.offsetHeight : null })),
        drawings: c.drawings,
      })),
    });
  }

  function restoreLayout() {
    const s = STORE.get('layout', null);
    if (!s) { setLayout('1'); return; }
    state.prePost = !!s.prePost;
    state.seriesType = s.seriesType || 'candles';
    state.dividendAdjusted = !!s.dividendAdjusted;
    state.reconcile = s.reconcile !== false;
    $('#btn-prepost').classList.toggle('on', state.prePost);
    setLayout(s.layout || '1', { skipLoad: true, skipSave: true });
    (s.cells || []).forEach(async (saved, i) => {
      const cell = state.cells[i];
      if (!cell) return;
      cell.drawings = saved.drawings || [];
      await loadCell(cell, saved.symbol || 'AAPL', saved.tf || '1d');
      for (const ind of saved.indicators || []) {
        const added = addIndicator(cell, ind.defId, ind.params, ind.color, { silent: true });
        if (added?.paneEl && ind.height) added.paneEl.style.height = ind.height + 'px';
      }
      renderLegend(cell);
    });
    setActive(s.active || 0);
  }

  /* ══ Panels ══════════════════════════════════════════════════════ */
  function openPanel(id) {
    const panel = $('#' + id);
    const wasOpen = panel.classList.contains('open');
    $$('.panel').forEach(p => p.classList.remove('open'));
    if (!wasOpen) panel.classList.add('open');
    // Charts are autoSize; nudge them after the transition so the width is right.
    setTimeout(() => state.cells.forEach(c => { try { c.chart.timeScale().applyOptions({}); } catch {} }), 260);
    return !wasOpen;
  }
  const closePanels = () => $$('.panel').forEach(p => p.classList.remove('open'));

  /* — watchlist — */
  let watchlist = [];
  function renderWatchlist() {
    const body = $('#watchlist-body');
    if (!watchlist.length) {
      body.innerHTML = '<div class="empty">No symbols yet.<br>Add one below to track it here.</div>';
      return;
    }
    body.textContent = '';
    for (const w of watchlist) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<div class="row-main"><div class="row-sym">${esc(w.symbol)}</div>
          <div class="row-name">${esc(w.name || '')}</div></div>
        <div class="row-right"><div class="row-px">${w.price != null ? DATA.fmtPrice(w.price) : '—'}</div>
          <div class="row-chg ${w.changePct >= 0 ? 'up' : 'down'}">${w.changePct != null ? (w.changePct >= 0 ? '+' : '') + w.changePct.toFixed(2) + '%' : ''}</div></div>
        <button class="row-del" title="Remove"><svg viewBox="0 0 16 16"><use href="#i-close"/></svg></button>`;
      row.addEventListener('click', e => {
        if (e.target.closest('.row-del')) {
          watchlist = watchlist.filter(x => x.symbol !== w.symbol);
          STORE.set('watchlist', watchlist.map(x => x.symbol));
          renderWatchlist();
          return;
        }
        loadCell(activeCell(), w.symbol, activeCell().tf);
      });
      body.append(row);
    }
  }
  async function refreshWatchlist() {
    if (!watchlist.length) return;
    const quotes = await DATA.fetchQuotes(watchlist.map(w => w.symbol), { concurrency: 4 });
    const by = new Map(quotes.map(q => [q.symbol.toUpperCase(), q]));
    watchlist = watchlist.map(w => ({ ...w, ...(by.get(w.symbol.toUpperCase()) || {}) }));
    STORE.set('watchlist', watchlist.map(w => w.symbol));
    renderWatchlist();
  }
  async function addToWatchlist(sym) {
    sym = sym.trim().toUpperCase();
    if (!sym || watchlist.some(w => w.symbol === sym)) return;
    watchlist.push({ symbol: sym });
    renderWatchlist();
    await refreshWatchlist();
  }

  /* — indicator panel — */
  let indTab = 'add';
  function refreshIndicatorPanel() {
    const body = $('#indicators-body');
    const q = $('#ind-search').value.trim().toLowerCase();
    $('#ind-search-wrap').hidden = indTab !== 'add';
    $$('[data-ind-tab]').forEach(t => t.classList.toggle('on', t.dataset.indTab === indTab));
    body.textContent = '';

    if (indTab === 'active') {
      const cell = activeCell();
      if (!cell?.indicators.length) {
        body.innerHTML = '<div class="empty">Nothing on this chart yet.<br>Pick one from the Add tab.</div>';
        return;
      }
      for (const ind of cell.indicators) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="legend-swatch" style="background:${ind.color};width:10px;height:3px"></span>
          <div class="row-main"><div class="row-sym">${esc(indLabel(ind.def, ind.params))}</div>
          <div class="row-name">${esc(ind.def.desc)}</div></div>
          <button class="row-del"><svg viewBox="0 0 16 16"><use href="#i-close"/></svg></button>`;
        row.addEventListener('click', e => {
          if (e.target.closest('.row-del')) removeIndicator(cell, ind.uid);
          else openIndicatorSettings(cell, ind);
        });
        body.append(row);
      }
      return;
    }

    const groups = {};
    for (const def of IND) {
      if (q && !(def.name.toLowerCase().includes(q) || def.desc.toLowerCase().includes(q) || def.id.includes(q))) continue;
      (groups[def.group] ||= []).push(def);
    }
    if (!Object.keys(groups).length) {
      body.innerHTML = '<div class="empty">No indicator matches that.</div>';
      return;
    }
    for (const [group, defs] of Object.entries(groups)) {
      const h = document.createElement('div');
      h.className = 'label ind-group-label'; h.textContent = group;
      body.append(h);
      for (const def of defs) {
        const item = document.createElement('div');
        item.className = 'ind-item';
        item.innerHTML = `<span class="ind-item-name">${esc(def.name)}</span><span class="ind-item-desc">${esc(def.desc)}</span>`;
        item.addEventListener('click', () => {
          addIndicator(activeCell(), def.id, {}, null);
          toast(`${def.name} added`, 'ok');
        });
        body.append(item);
      }
    }
  }

  function openIndicatorSettings(cell, ind) {
    openPanel('panel-settings');
    const body = $('#settings-body');
    $('#panel-settings .panel-title').textContent = indLabel(ind.def, ind.params);
    body.textContent = '';
    for (const p of ind.def.params) {
      const row = document.createElement('div');
      row.className = 'setting';
      const lab = document.createElement('label'); lab.textContent = p.label;
      let input;
      if (p.type === 'select') {
        input = document.createElement('select'); input.className = 'field';
        for (const o of p.options) {
          const opt = document.createElement('option'); opt.value = o; opt.textContent = o;
          input.append(opt);
        }
        input.value = ind.params[p.id];
      } else {
        input = document.createElement('input');
        input.className = 'field'; input.type = 'number';
        input.value = ind.params[p.id];
        if (p.min != null) input.min = p.min;
        if (p.max != null) input.max = p.max;
        input.step = p.step || 1;
      }
      input.addEventListener('change', () => {
        const v = p.type === 'select' ? input.value : clamp(parseFloat(input.value) || p.def, p.min ?? -1e9, p.max ?? 1e9);
        if (p.type !== 'select') input.value = v;
        ind.params[p.id] = v;
        buildIndicator(cell, ind);
        renderLegend(cell);
        $('#panel-settings .panel-title').textContent = indLabel(ind.def, ind.params);
        saveLayout();
      });
      row.append(lab, input);
      body.append(row);
    }
    const colorRow = document.createElement('div');
    colorRow.className = 'setting';
    const cl = document.createElement('label'); cl.textContent = 'Colour';
    const ci = document.createElement('input');
    ci.type = 'color'; ci.value = /^#[\da-f]{6}$/i.test(ind.color) ? ind.color : '#4B9BE8';
    ci.addEventListener('input', () => {
      ind.color = ci.value; buildIndicator(cell, ind); renderLegend(cell); saveLayout();
    });
    colorRow.append(cl, ci);
    body.append(colorRow);

    const rm = document.createElement('div');
    rm.className = 'setting';
    const btn = document.createElement('button');
    btn.className = 'btn'; btn.textContent = 'Remove indicator';
    btn.style.color = 'var(--down)';
    btn.addEventListener('click', () => { removeIndicator(cell, ind.uid); closePanels(); });
    rm.append(btn);
    body.append(rm);
  }

  function openAppSettings() {
    openPanel('panel-settings');
    $('#panel-settings .panel-title').textContent = 'Settings';
    const body = $('#settings-body');
    body.textContent = '';

    const group = (title) => {
      const h = document.createElement('div');
      h.className = 'label ind-group-label'; h.textContent = title;
      body.append(h);
    };
    const select = (label, value, options, onChange) => {
      const row = document.createElement('div'); row.className = 'setting';
      const l = document.createElement('label'); l.textContent = label;
      const s = document.createElement('select'); s.className = 'field'; s.style.width = '140px';
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.id; opt.textContent = o.name; s.append(opt);
      }
      s.value = value;
      s.addEventListener('change', () => onChange(s.value));
      row.append(l, s); body.append(row);
    };
    const toggle = (label, value, hint, onChange) => {
      const row = document.createElement('div'); row.className = 'setting';
      const l = document.createElement('label');
      l.innerHTML = `${esc(label)}<div style="font-size:11px;color:var(--dim)">${esc(hint)}</div>`;
      const b = document.createElement('button');
      b.className = 'btn' + (value ? ' on' : ''); b.textContent = value ? 'On' : 'Off';
      b.addEventListener('click', () => { onChange(!value); openAppSettings(); });
      row.append(l, b); body.append(row);
    };

    group('Chart');
    select('Candle type', state.seriesType, SERIES_TYPES, v => {
      state.seriesType = v; saveLayout();
      for (const c of state.cells) if (c.bars.length) {
        try { c.chart.removeSeries(c.series); } catch {}
        c.series = buildMainSeries(c.chart, v, c.bars);
        c.series.applyOptions({ priceFormat: priceFormat(c.bars[c.bars.length - 1].close) });
      }
    });

    group('Data');
    toggle('Include auction prints', state.reconcile,
      "Yahoo's intraday feed omits the opening and closing auctions, so the first and last candle of each session disagree with other platforms. On, they are taken from the official daily bar.", v => {
        state.reconcile = v;
        state.cells.forEach(c => c.symbol && loadCell(c, c.symbol, c.tf));
      });
    toggle('Extended hours', state.prePost,
      'Include pre-market and after-hours bars on intraday charts.', v => {
        state.prePost = v; $('#btn-prepost').classList.toggle('on', v);
        state.cells.forEach(c => c.symbol && loadCell(c, c.symbol, c.tf));
      });
    toggle('Adjust for dividends', state.dividendAdjusted,
      'Off shows split-adjusted prices, matching most charting platforms. On back-adjusts history for dividends too.', v => {
        state.dividendAdjusted = v;
        state.cells.forEach(c => c.symbol && loadCell(c, c.symbol, c.tf));
      });

    group('Profile');
    const info = document.createElement('div');
    info.className = 'empty';
    info.style.textAlign = 'left';
    info.innerHTML = `Signed in as <b>${esc(state.profile || 'default')}</b>. Layouts, watchlists and
      indicators are stored per profile in this browser only.`;
    body.append(info);
    const out = document.createElement('div'); out.className = 'setting';
    const ob = document.createElement('button');
    ob.className = 'btn'; ob.textContent = 'Lock';
    ob.addEventListener('click', () => { sessionStorage.removeItem('tc:session'); location.reload(); });
    out.append(ob); body.append(out);
  }

  /* — scanner — */
  const SCAN_UNIVERSE = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'JPM', 'V',
    'UNH', 'XOM', 'LLY', 'JNJ', 'WMT', 'MA', 'PG', 'HD', 'MRK', 'CVX',
    'AMD', 'NFLX', 'ADBE', 'PLTR', 'COIN', 'MSTR', 'SOFI', 'HOOD', 'RIVN', 'GME',
  ];
  let scanTab = 'gainers', scanRows = [];

  async function runScan() {
    const body = $('#scanner-body');
    body.innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto 10px"></div>Scanning 30 symbols</div>';
    try {
      scanRows = await DATA.fetchQuotes(SCAN_UNIVERSE, {
        concurrency: 6,
        onProgress: (d, t) => { const e = $('#scanner-body .empty'); if (e) e.lastChild.textContent = `Scanning ${d} of ${t}`; },
      });
      renderScan();
    } catch (e) {
      body.innerHTML = `<div class="empty">Scan failed: ${esc(e.message)}</div>`;
    }
  }

  function renderScan() {
    const body = $('#scanner-body');
    $('#scan-filters').hidden = scanTab !== 'custom';
    $$('[data-scan-tab]').forEach(t => t.classList.toggle('on', t.dataset.scanTab === scanTab));
    let rows = [...scanRows];

    if (scanTab === 'gainers') rows.sort((a, b) => b.changePct - a.changePct);
    else if (scanTab === 'losers') rows.sort((a, b) => a.changePct - b.changePct);
    else if (scanTab === 'active') rows.sort((a, b) => b.volume - a.volume);
    else {
      const nv = id => { const v = parseFloat($('#' + id).value); return Number.isFinite(v) ? v : null; };
      const minpx = nv('f-minpx'), maxpx = nv('f-maxpx'), minchg = nv('f-minchg'),
            maxchg = nv('f-maxchg'), minvol = nv('f-minvol'), hi52 = nv('f-hi52');
      rows = rows.filter(r =>
        (minpx == null || r.price >= minpx) && (maxpx == null || r.price <= maxpx) &&
        (minchg == null || r.changePct >= minchg) && (maxchg == null || r.changePct <= maxchg) &&
        (minvol == null || r.volume >= minvol * 1e6) &&
        (hi52 == null || (r.fiftyTwoWeekHigh > 0 && (r.fiftyTwoWeekHigh - r.price) / r.fiftyTwoWeekHigh * 100 <= hi52)));
      rows.sort((a, b) => b.changePct - a.changePct);
    }

    if (!rows.length) {
      body.innerHTML = scanRows.length
        ? '<div class="empty">Nothing matches those filters.</div>'
        : '<div class="empty">Run a scan to see results.</div>';
      return;
    }
    body.textContent = '';
    for (const r of rows.slice(0, 40)) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<div class="row-main"><div class="row-sym">${esc(r.symbol)}</div>
          <div class="row-name">${esc(r.name)} · ${DATA.fmtVolume(r.volume)}</div></div>
        <div class="row-right"><div class="row-px">${DATA.fmtPrice(r.price)}</div>
          <div class="row-chg ${r.changePct >= 0 ? 'up' : 'down'}">${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%</div></div>`;
      row.addEventListener('click', () => loadCell(activeCell(), r.symbol, activeCell().tf));
      body.append(row);
    }
  }

  /* — news — */
  async function loadNews() {
    const cell = activeCell();
    const body = $('#news-body');
    if (!cell?.symbol) { body.innerHTML = '<div class="empty">Load a symbol first.</div>'; return; }
    body.innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto 10px"></div>Fetching headlines</div>';
    try {
      const url = `${DATA.YF}/v1/finance/search?q=${encodeURIComponent(cell.symbol)}&quotesCount=0&newsCount=20`;
      const json = await DATA.getJSON(url, 10000);
      const items = json?.news || [];
      if (!items.length) { body.innerHTML = `<div class="empty">No recent headlines for ${esc(cell.symbol)}.</div>`; return; }
      body.textContent = '';
      const head = document.createElement('div');
      head.className = 'label ind-group-label';
      head.textContent = cell.symbol;
      body.append(head);
      for (const n of items) {
        const a = document.createElement('a');
        a.className = 'row'; a.style.textDecoration = 'none'; a.style.color = 'inherit';
        a.href = safeUrl(n.link); a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.innerHTML = `<div class="row-main"><div style="font-size:12px;line-height:1.4">${esc(n.title)}</div>
          <div class="row-name">${esc(n.publisher || '')} · ${timeAgo(n.providerPublishTime)}</div></div>`;
        body.append(a);
      }
    } catch (e) {
      body.innerHTML = `<div class="empty">Could not load news: ${esc(e.message)}</div>`;
    }
  }
  const refreshNewsIfOpen = () => { if ($('#panel-news').classList.contains('open')) loadNews(); };
  function timeAgo(sec) {
    if (!sec) return '';
    const d = Math.floor(Date.now() / 1000 - sec);
    if (d < 3600) return Math.max(1, Math.floor(d / 60)) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  /* — script editor — */
  const TEMPLATES = {
    'Moving average': `// @name: My MA
const fast = sma(close, 10);
const slow = sma(close, 30);
plot(fast, { color: '#4B9BE8', title: 'Fast' });
plot(slow, { color: '#E8B34A', title: 'Slow' });`,
    'RSI divergence band': `// @name: RSI band
const r = rsi(close, 14);
plot(r, { color: '#C98BDB' });
hline(70); hline(30);`,
    'Range breakout': `// @name: Breakout
const hi = highest(high, 20);
const lo = lowest(low, 20);
plot(hi, { color: '#2EBD85', dashed: true });
plot(lo, { color: '#F0616D', dashed: true });`,
    'Volatility ratio': `// @name: Vol ratio
const a = atr(14);
const base = sma(a, 50);
plot(a.map((v, i) => v && base[i] ? v / base[i] : null), { color: '#E8B34A' });
hline(1);`,
  };

  let editor = null;
  function initEditor() {
    if (editor || !window.CodeMirror) return;
    editor = CodeMirror.fromTextArea($('#editor-area'), {
      mode: 'javascript', lineNumbers: true, matchBrackets: true,
      indentUnit: 2, tabSize: 2, lineWrapping: true,
      extraKeys: { 'Ctrl-Enter': runEditor, 'Cmd-Enter': runEditor },
    });
    const sel = $('#editor-template');
    for (const k of Object.keys(TEMPLATES)) {
      const o = document.createElement('option'); o.value = k; o.textContent = k; sel.append(o);
    }
    sel.addEventListener('change', () => editor.setValue(TEMPLATES[sel.value] || ''));
    editor.setValue(STORE.get('script', TEMPLATES['Moving average']));
  }

  // The scripting surface is a small, explicit set of helpers over the same
  // verified TA engine — not a general eval of page scope.
  function runEditor() {
    const cell = activeCell();
    if (!cell?.bars.length) { toast('Load a symbol first', 'error'); return; }
    const source = editor.getValue();
    STORE.set('script', source);
    const name = (source.match(/\/\/\s*@name:\s*(.+)/) || [, 'Script'])[1].trim();

    const bars = cell.bars;
    const plots = [], levels = [];
    const api = {
      close: TA.col(bars, 'close'), open: TA.col(bars, 'open'),
      high: TA.col(bars, 'high'), low: TA.col(bars, 'low'),
      volume: TA.col(bars, 'volume'), hl2: TA.hl2(bars), hlc3: TA.hlc3(bars),
      sma: TA.sma, ema: TA.ema, rma: TA.rma, wma: TA.wma, stdev: TA.stdev,
      rsi: TA.rsi, highest: TA.highest, lowest: TA.lowest, change: TA.change,
      atr: n => TA.atr(bars, n), macd: (f, s, g) => TA.macd(TA.col(bars, 'close'), f, s, g),
      plot: (values, o = {}) => { if (Array.isArray(values)) plots.push({ kind: o.hist ? 'hist' : 'line', values, ...o }); },
      hline: v => levels.push(v),
    };
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(...Object.keys(api), source);
      fn(...Object.values(api));
    } catch (e) {
      toast(`Script error: ${e.message}`, 'error');
      return;
    }
    if (!plots.length) { toast('Script produced no plots', 'error'); return; }

    // Register it as a one-off indicator definition so it lives in the same
    // lifecycle as everything else (legend, settings, persistence).
    const id = 'script:' + name;
    INDBY[id] = {
      id, name, group: 'Scripts', desc: 'Custom script', overlay: !levels.length,
      paneHeight: 90, params: [], levels: levels.length ? levels : undefined,
      compute: () => plots,
    };
    const existing = cell.indicators.find(i => i.defId === id);
    if (existing) removeIndicator(cell, existing.uid);
    addIndicator(cell, id, {}, '#E8B34A');
    toast(`${name} added`, 'ok');
  }

  /* ══ Symbol search ═══════════════════════════════════════════════ */
  let searchTimer = null, searchResults = [], searchSel = 0;
  function openSearch() {
    $('#search-overlay').classList.add('open');
    const input = $('#search-input');
    input.value = ''; input.focus();
    $('#search-results').innerHTML = '<div class="empty">Type to search Yahoo Finance.</div>';
  }
  const closeSearch = () => $('#search-overlay').classList.remove('open');

  function renderSearch() {
    const box = $('#search-results');
    box.textContent = '';
    searchResults.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (i === searchSel ? ' sel' : '');
      row.innerHTML = `<div class="row-main"><div class="row-sym">${esc(r.symbol)}</div>
        <div class="row-name">${esc(r.name)}</div></div>
        <div class="row-right"><div class="row-name">${esc(r.exchange)}</div></div>`;
      row.addEventListener('click', () => pickSearch(i));
      box.append(row);
    });
  }
  function pickSearch(i) {
    const r = searchResults[i];
    if (!r) return;
    closeSearch();
    loadCell(activeCell(), r.symbol, activeCell().tf);
  }

  /* ══ Lock screen ═════════════════════════════════════════════════
     A per-profile screen lock, not authentication. Passphrases are stored
     as a SHA-256 hash so the raw string is not sitting in localStorage, but
     the page is public and entirely client-side: anyone can read the code
     and the stored layout. It is labelled that way in the UI rather than
     implying protection it cannot provide.                                */
  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const profiles = {
    all: () => { try { return JSON.parse(localStorage.getItem('tc:profiles') || '[]'); } catch { return []; } },
    save: list => localStorage.setItem('tc:profiles', JSON.stringify(list)),
  };

  async function initLock() {
    const existing = profiles.all();
    const session = sessionStorage.getItem('tc:session');
    if (session && existing.some(p => p.user === session)) { state.profile = session; return true; }
    if (!existing.length) { state.profile = null; return true; }   // never set up: no lock

    let creating = false;
    const lock = $('#lock'), err = $('#lock-err');
    lock.hidden = false;
    $('#lock-user').focus();

    return new Promise(resolve => {
      const setMode = c => {
        creating = c;
        $('#lock-pass2').hidden = !c;
        $('#lock-go').textContent = c ? 'Create profile' : 'Unlock';
        $('#lock-sub').textContent = c
          ? 'Pick a name and passphrase for a separate saved layout.'
          : 'Enter your passphrase to unlock this browser.';
        $('#lock-toggle').textContent = c ? 'Use an existing profile' : 'Set up a new profile';
        err.textContent = '';
      };
      $('#lock-toggle').addEventListener('click', () => setMode(!creating));
      $('#lock-skip').addEventListener('click', () => { state.profile = null; lock.hidden = true; resolve(true); });
      $('#lock-form').addEventListener('submit', async e => {
        e.preventDefault();
        const user = $('#lock-user').value.trim();
        const pass = $('#lock-pass').value;
        if (!user || !pass) { err.textContent = 'Enter a name and a passphrase.'; return; }
        const list = profiles.all();
        if (creating) {
          if (list.some(p => p.user.toLowerCase() === user.toLowerCase())) { err.textContent = 'That name is taken.'; return; }
          if (pass !== $('#lock-pass2').value) { err.textContent = 'The passphrases do not match.'; return; }
          if (pass.length < 4) { err.textContent = 'Use at least 4 characters.'; return; }
          list.push({ user, hash: await sha256(user.toLowerCase() + ':' + pass) });
          profiles.save(list);
        } else {
          const found = list.find(p => p.user.toLowerCase() === user.toLowerCase());
          if (!found || found.hash !== await sha256(user.toLowerCase() + ':' + pass)) {
            err.textContent = 'That name and passphrase do not match.';
            return;
          }
        }
        state.profile = user;
        sessionStorage.setItem('tc:session', user);
        lock.hidden = true;
        resolve(true);
      });
    });
  }

  /* ══ Utilities ═══════════════════════════════════════════════════ */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function safeUrl(u) {
    try { const p = new URL(u); return (p.protocol === 'https:' || p.protocol === 'http:') ? u : '#'; }
    catch { return '#'; }
  }
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 4200 : 2200);
  }

  /* ══ Wiring ══════════════════════════════════════════════════════ */
  function wireChrome() {
    $('#layouts').addEventListener('click', e => {
      const b = e.target.closest('[data-layout]');
      if (b) setLayout(b.dataset.layout);
    });
    $('#rail').addEventListener('click', e => {
      const b = e.target.closest('[data-tool]');
      if (b) setTool(b.dataset.tool);
    });
    $('#btn-clear-draw').addEventListener('click', () => {
      const c = activeCell();
      c.drawings = []; redrawDrawings(c); saveLayout();
      toast('Drawings cleared');
    });

    $('#btn-search').addEventListener('click', openSearch);
    $('#btn-indicators').addEventListener('click', () => { if (openPanel('panel-indicators')) refreshIndicatorPanel(); });
    $('#btn-watchlist').addEventListener('click', () => { if (openPanel('panel-watchlist')) { renderWatchlist(); refreshWatchlist(); } });
    $('#btn-scanner').addEventListener('click', () => { if (openPanel('panel-scanner') && !scanRows.length) runScan(); });
    $('#btn-news').addEventListener('click', () => { if (openPanel('panel-news')) loadNews(); });
    $('#btn-editor').addEventListener('click', () => { if (openPanel('panel-editor')) { initEditor(); setTimeout(() => editor?.refresh(), 260); } });
    $('#btn-settings').addEventListener('click', openAppSettings);
    $$('[data-close-panel]').forEach(b => b.addEventListener('click', closePanels));

    $('#btn-fit').addEventListener('click', () => activeCell()?.chart.timeScale().fitContent());
    $('#btn-prepost').addEventListener('click', () => {
      state.prePost = !state.prePost;
      $('#btn-prepost').classList.toggle('on', state.prePost);
      state.cells.forEach(c => c.symbol && loadCell(c, c.symbol, c.tf));
      saveLayout();
    });

    $('#watchlist-add-btn').addEventListener('click', () => {
      addToWatchlist($('#watchlist-add').value); $('#watchlist-add').value = '';
    });
    $('#watchlist-add').addEventListener('keydown', e => {
      if (e.key === 'Enter') { addToWatchlist(e.target.value); e.target.value = ''; }
    });

    $$('[data-ind-tab]').forEach(t => t.addEventListener('click', () => { indTab = t.dataset.indTab; refreshIndicatorPanel(); }));
    $('#ind-search').addEventListener('input', refreshIndicatorPanel);

    $$('[data-scan-tab]').forEach(t => t.addEventListener('click', () => {
      scanTab = t.dataset.scanTab;
      if (!scanRows.length) runScan(); else renderScan();
    }));
    $('#scanner-run').addEventListener('click', runScan);
    $('#scan-filters').addEventListener('input', () => { if (scanTab === 'custom') renderScan(); });
    $('#news-refresh').addEventListener('click', loadNews);
    $('#editor-run').addEventListener('click', runEditor);
    $('#editor-remove').addEventListener('click', () => {
      const cell = activeCell();
      const scripted = cell.indicators.filter(i => i.defId.startsWith('script:'));
      scripted.forEach(i => removeIndicator(cell, i.uid));
      toast(scripted.length ? 'Script removed' : 'No script on this chart');
    });

    // search overlay
    const input = $('#search-input');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length < 1) { searchResults = []; renderSearch(); return; }
      searchTimer = setTimeout(async () => {
        try {
          searchResults = await DATA.search(q);
          searchSel = 0;
          if (!searchResults.length) $('#search-results').innerHTML = '<div class="empty">Nothing found.</div>';
          else renderSearch();
        } catch { $('#search-results').innerHTML = '<div class="empty">Search is unavailable right now.</div>'; }
      }, 220);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { searchSel = Math.min(searchSel + 1, searchResults.length - 1); renderSearch(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { searchSel = Math.max(searchSel - 1, 0); renderSearch(); e.preventDefault(); }
      else if (e.key === 'Enter') pickSearch(searchSel);
    });
    $('#search-overlay').addEventListener('click', e => { if (e.target.id === 'search-overlay') closeSearch(); });

    document.addEventListener('keydown', e => {
      const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.closest('.CodeMirror');
      if (e.key === 'Escape') {
        if ($('#search-overlay').classList.contains('open')) closeSearch();
        else if (pending) { pending = null; toast('Cancelled'); }
        else closePanels();
        return;
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); openSearch(); }
      else if (e.key >= '1' && e.key <= '6' && !e.metaKey && !e.ctrlKey) {
        const map = ['1', '2', '2v', '3', '4', '6'];
        setLayout(map[+e.key - 1]);
      } else if (e.key.toLowerCase() === 'i') { if (openPanel('panel-indicators')) refreshIndicatorPanel(); }
      else if (e.key.toLowerCase() === 'w') { if (openPanel('panel-watchlist')) { renderWatchlist(); refreshWatchlist(); } }
      else if (e.key.toLowerCase() === 'f') activeCell()?.chart.timeScale().fitContent();
    });

    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollOnce().catch(() => {}); });
  }

  /* ══ Boot ════════════════════════════════════════════════════════ */
  async function boot() {
    if (!window.LightweightCharts) {
      document.body.innerHTML = '<div class="empty" style="padding-top:20vh">Charting library failed to load.<br>Check your connection and reload.</div>';
      return;
    }
    await initLock();
    wireChrome();
    watchlist = (STORE.get('watchlist', ['AAPL', 'NVDA', 'TSLA', 'SPY'])).map(s => typeof s === 'string' ? { symbol: s } : s);
    restoreLayout();
    startPolling();
    setInterval(() => {
      updateMarketState();
      const now = Date.now() / 1000;
      for (const c of state.cells) renderRibbon(c, now);
    }, 1000);
    setTool('cursor');
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
