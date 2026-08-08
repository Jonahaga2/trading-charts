/* ═══════════════════════════════════════════════════════════════════════
   TA — technical analysis math engine
   ───────────────────────────────────────────────────────────────────────
   Conventions, applied uniformly:
     • `null` means "not available yet" (Pine's `na`). Never 0, never a
       silently-substituted value. Feeding a null into a moving average
       yields null, so a warm-up period can never leak into a plotted value.
     • Warm-up matches TradingView Pine v5: ta.ema / ta.rma emit their first
       value at index n-1, seeded with the SMA of the first n samples.
       (Seeding from src[0] instead — as naive implementations do — leaves
       the first ~4n bars materially wrong.)
     • Wilder's indicators (RSI, ATR, ADX, DMI) use RMA (alpha = 1/n), NOT
       EMA (alpha = 2/(n+1)). These are different numbers, not a nuance.
     • No function mutates its input.
   Verified by test/ta.test.mjs against hand-computed golden values, an
   independent naive implementation, and structural invariants.
   ═══════════════════════════════════════════════════════════════════════ */
const TA = (() => {
  'use strict';

  const isNum = v => v != null && typeof v === 'number' && Number.isFinite(v);
  const filled = n => new Array(n).fill(null);

  /* ── Rolling primitives ───────────────────────────────────────────────
     Each is O(n) rather than O(n·period). `highest`/`lowest` use a
     monotonic deque, which also avoids Math.max(...spread) blowing the
     stack on long windows. */

  function sma(src, n) {
    const len = src.length, out = filled(len);
    if (n < 1) return out;
    let sum = 0, count = 0, start = 0;
    for (let i = 0; i < len; i++) {
      if (!isNum(src[i])) { sum = 0; count = 0; start = i + 1; continue; }
      sum += src[i]; count++;
      if (count > n) { sum -= src[i - n]; count = n; }
      if (count === n && i - start >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  // Generic Wilder/exponential recursion with a Pine-compatible SMA seed.
  function _smoothed(src, n, alpha) {
    const len = src.length, out = filled(len);
    if (n < 1) return out;
    let seed = 0, count = 0, prev = null;
    for (let i = 0; i < len; i++) {
      if (!isNum(src[i])) { if (prev === null) { seed = 0; count = 0; } continue; }
      if (prev === null) {
        seed += src[i]; count++;
        if (count === n) { prev = seed / n; out[i] = prev; }
      } else {
        prev = alpha * src[i] + (1 - alpha) * prev;
        out[i] = prev;
      }
    }
    return out;
  }

  const ema = (src, n) => _smoothed(src, n, 2 / (n + 1));
  const rma = (src, n) => _smoothed(src, n, 1 / n);   // Wilder's smoothing

  function wma(src, n) {
    const len = src.length, out = filled(len), denom = n * (n + 1) / 2;
    for (let i = n - 1; i < len; i++) {
      let acc = 0, ok = true;
      for (let j = 0; j < n; j++) {
        const v = src[i - n + 1 + j];
        if (!isNum(v)) { ok = false; break; }
        acc += v * (j + 1);
      }
      if (ok) out[i] = acc / denom;
    }
    return out;
  }

  // Population standard deviation (matches Pine's ta.stdev, and so Bollinger).
  // Rolling mean for speed; variance computed over the window for numerical
  // stability (a rolling sum-of-squares drifts badly over thousands of bars).
  function stdev(src, n) {
    const len = src.length, out = filled(len);
    const means = sma(src, n);
    for (let i = n - 1; i < len; i++) {
      if (means[i] === null) continue;
      const m = means[i];
      let acc = 0;
      for (let j = i - n + 1; j <= i; j++) acc += (src[j] - m) ** 2;
      out[i] = Math.sqrt(acc / n);
    }
    return out;
  }

  // Monotonic-deque extremes. `strict` decides tie-breaking direction.
  function _extreme(src, n, cmp) {
    const len = src.length, out = filled(len), dq = [];
    for (let i = 0; i < len; i++) {
      if (!isNum(src[i])) { dq.length = 0; continue; }
      while (dq.length && dq[0] <= i - n) dq.shift();
      while (dq.length && cmp(src[i], src[dq[dq.length - 1]])) dq.pop();
      dq.push(i);
      if (i >= n - 1) {
        let ok = true;
        for (let j = i - n + 1; j <= i; j++) if (!isNum(src[j])) { ok = false; break; }
        if (ok) out[i] = src[dq[0]];
      }
    }
    return out;
  }
  const highest = (src, n) => _extreme(src, n, (a, b) => a >= b);
  const lowest  = (src, n) => _extreme(src, n, (a, b) => a <= b);

  const change = (src, n = 1) =>
    src.map((v, i) => (i >= n && isNum(v) && isNum(src[i - n])) ? v - src[i - n] : null);

  /* ── Bar-series helpers ───────────────────────────────────────────── */
  const col = (bars, k) => bars.map(b => b[k]);
  const hl2  = bars => bars.map(b => (b.high + b.low) / 2);
  const hlc3 = bars => bars.map(b => (b.high + b.low + b.close) / 3);
  const ohlc4 = bars => bars.map(b => (b.open + b.high + b.low + b.close) / 4);

  function source(bars, name) {
    switch (name) {
      case 'open':  return col(bars, 'open');
      case 'high':  return col(bars, 'high');
      case 'low':   return col(bars, 'low');
      case 'hl2':   return hl2(bars);
      case 'hlc3':  return hlc3(bars);
      case 'ohlc4': return ohlc4(bars);
      default:      return col(bars, 'close');
    }
  }

  // True Range. tr[0] = high-low (no prior close exists).
  function trueRange(bars) {
    return bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const pc = bars[i - 1].close;
      return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });
  }

  /* ── Moving averages ──────────────────────────────────────────────── */
  function dema(src, n) {
    const e1 = ema(src, n), e2 = ema(e1, n);
    return src.map((_, i) => (e1[i] !== null && e2[i] !== null) ? 2 * e1[i] - e2[i] : null);
  }
  function tema(src, n) {
    const e1 = ema(src, n), e2 = ema(e1, n), e3 = ema(e2, n);
    return src.map((_, i) =>
      (e1[i] !== null && e2[i] !== null && e3[i] !== null) ? 3 * e1[i] - 3 * e2[i] + e3[i] : null);
  }
  // Pine: wma(2*wma(src, n/2) - wma(src, n), round(sqrt(n))); n/2 is integer division.
  function hma(src, n) {
    const half = wma(src, Math.floor(n / 2)), full = wma(src, n);
    const diff = half.map((v, i) => (v !== null && full[i] !== null) ? 2 * v - full[i] : null);
    return wma(diff, Math.max(1, Math.round(Math.sqrt(n))));
  }
  function zlema(src, n) {
    const lag = Math.floor((n - 1) / 2);
    const adj = src.map((v, i) => (isNum(v) && i >= lag && isNum(src[i - lag])) ? 2 * v - src[i - lag] : null);
    return ema(adj, n);
  }
  function alma(src, n, offset = 0.85, sigma = 6) {
    const len = src.length, out = filled(len);
    const m = offset * (n - 1), s = n / sigma;
    const w = Array.from({ length: n }, (_, i) => Math.exp(-((i - m) ** 2) / (2 * s * s)));
    const wsum = w.reduce((a, b) => a + b, 0);
    for (let i = n - 1; i < len; i++) {
      let acc = 0, ok = true;
      for (let j = 0; j < n; j++) {
        const v = src[i - n + 1 + j];
        if (!isNum(v)) { ok = false; break; }
        acc += w[j] * v;
      }
      if (ok) out[i] = acc / wsum;
    }
    return out;
  }
  function vwma(bars, n) {
    const len = bars.length, out = filled(len);
    let pv = 0, vol = 0;
    for (let i = 0; i < len; i++) {
      const v = bars[i].volume || 0;
      pv += bars[i].close * v; vol += v;
      if (i >= n) { const o = bars[i - n]; pv -= o.close * (o.volume || 0); vol -= (o.volume || 0); }
      if (i >= n - 1) out[i] = vol > 0 ? pv / vol : null;
    }
    return out;
  }

  /* ── Volatility / bands ───────────────────────────────────────────── */
  const atr = (bars, n) => rma(trueRange(bars), n);   // Wilder — NOT ema

  function bollinger(bars, n, mult, srcName = 'close') {
    const src = source(bars, srcName);
    const mid = sma(src, n), dev = stdev(src, n);
    return {
      mid,
      upper: mid.map((v, i) => (v !== null && dev[i] !== null) ? v + mult * dev[i] : null),
      lower: mid.map((v, i) => (v !== null && dev[i] !== null) ? v - mult * dev[i] : null),
    };
  }
  function keltner(bars, n, mult) {
    const mid = ema(col(bars, 'close'), n), a = atr(bars, n);
    return {
      mid,
      upper: mid.map((v, i) => (v !== null && a[i] !== null) ? v + mult * a[i] : null),
      lower: mid.map((v, i) => (v !== null && a[i] !== null) ? v - mult * a[i] : null),
    };
  }
  function donchian(bars, n) {
    const hi = highest(col(bars, 'high'), n), lo = lowest(col(bars, 'low'), n);
    return { upper: hi, lower: lo, mid: hi.map((v, i) => (v !== null && lo[i] !== null) ? (v + lo[i]) / 2 : null) };
  }
  function envelope(bars, n, pct) {
    const ma = sma(col(bars, 'close'), n), k = pct / 100;
    return {
      mid: ma,
      upper: ma.map(v => v !== null ? v * (1 + k) : null),
      lower: ma.map(v => v !== null ? v * (1 - k) : null),
    };
  }
  // Choppiness = 100 * log10(sum(TR, n) / (highest(high,n) - lowest(low,n))) / log10(n)
  function chop(bars, n) {
    const tr = trueRange(bars), len = bars.length, out = filled(len);
    const hi = highest(col(bars, 'high'), n), lo = lowest(col(bars, 'low'), n);
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += tr[i];
      if (i >= n) sum -= tr[i - n];
      if (i >= n - 1 && hi[i] !== null && lo[i] !== null) {
        const rng = hi[i] - lo[i];
        out[i] = rng > 0 ? 100 * Math.log10(sum / rng) / Math.log10(n) : null;
      }
    }
    return out;
  }

  /* ── Oscillators ──────────────────────────────────────────────────── */
  function rsi(src, n) {
    const ch = change(src);
    const gain = ch.map(v => v === null ? null : Math.max(v, 0));
    const loss = ch.map(v => v === null ? null : Math.max(-v, 0));
    const ag = rma(gain, n), al = rma(loss, n);
    return src.map((_, i) => {
      if (ag[i] === null || al[i] === null) return null;
      // A perfectly flat window has neither gain nor loss, so the ratio is 0/0.
      // Report the neutral midpoint rather than 100 — a motionless tape is not
      // maximum strength. (TA-Lib returns 100 here, which reads as a false
      // overbought signal on illiquid symbols that print unchanged for a while.)
      if (ag[i] === 0 && al[i] === 0) return 50;
      if (al[i] === 0) return 100;
      if (ag[i] === 0) return 0;
      return 100 - 100 / (1 + ag[i] / al[i]);
    });
  }

  function macd(src, fast, slow, sig) {
    const ef = ema(src, fast), es = ema(src, slow);
    const line = ef.map((v, i) => (v !== null && es[i] !== null) ? v - es[i] : null);
    const signal = ema(line, sig);
    return { line, signal, hist: line.map((v, i) => (v !== null && signal[i] !== null) ? v - signal[i] : null) };
  }

  function stoch(bars, kPeriod, dPeriod, smoothK = 1) {
    const hi = highest(col(bars, 'high'), kPeriod), lo = lowest(col(bars, 'low'), kPeriod);
    const raw = bars.map((b, i) => {
      if (hi[i] === null || lo[i] === null) return null;
      const rng = hi[i] - lo[i];
      return rng === 0 ? 50 : (b.close - lo[i]) / rng * 100;
    });
    const k = smoothK > 1 ? sma(raw, smoothK) : raw;
    return { k, d: sma(k, dPeriod) };
  }

  function stochRsi(src, rsiPeriod, stochPeriod, kSmooth = 3, dSmooth = 3) {
    const r = rsi(src, rsiPeriod);
    const hi = highest(r, stochPeriod), lo = lowest(r, stochPeriod);
    const raw = r.map((v, i) => {
      if (v === null || hi[i] === null || lo[i] === null) return null;
      const rng = hi[i] - lo[i];
      return rng === 0 ? 50 : (v - lo[i]) / rng * 100;
    });
    const k = sma(raw, kSmooth);
    return { k, d: sma(k, dSmooth) };
  }

  function cci(bars, n) {
    const tp = hlc3(bars), len = bars.length, out = filled(len);
    const m = sma(tp, n);
    for (let i = n - 1; i < len; i++) {
      if (m[i] === null) continue;
      let dev = 0;
      for (let j = i - n + 1; j <= i; j++) dev += Math.abs(tp[j] - m[i]);
      dev /= n;
      out[i] = dev === 0 ? 0 : (tp[i] - m[i]) / (0.015 * dev);
    }
    return out;
  }

  function williamsR(bars, n) {
    const hi = highest(col(bars, 'high'), n), lo = lowest(col(bars, 'low'), n);
    return bars.map((b, i) => {
      if (hi[i] === null || lo[i] === null) return null;
      const rng = hi[i] - lo[i];
      return rng === 0 ? -50 : (hi[i] - b.close) / rng * -100;
    });
  }

  // Wilder's ADX/DMI, RMA-smoothed throughout.
  function adx(bars, n) {
    const len = bars.length;
    const tr = trueRange(bars), plusDM = filled(len), minusDM = filled(len);
    plusDM[0] = 0; minusDM[0] = 0;
    for (let i = 1; i < len; i++) {
      const up = bars[i].high - bars[i - 1].high;
      const down = bars[i - 1].low - bars[i].low;
      plusDM[i]  = (up > down && up > 0) ? up : 0;
      minusDM[i] = (down > up && down > 0) ? down : 0;
    }
    const trR = rma(tr, n), pR = rma(plusDM, n), mR = rma(minusDM, n);
    const plusDI  = pR.map((v, i) => (v !== null && trR[i] > 0) ? 100 * v / trR[i] : null);
    const minusDI = mR.map((v, i) => (v !== null && trR[i] > 0) ? 100 * v / trR[i] : null);
    const dx = plusDI.map((v, i) => {
      if (v === null || minusDI[i] === null) return null;
      const sum = v + minusDI[i];
      return sum === 0 ? 0 : 100 * Math.abs(v - minusDI[i]) / sum;
    });
    return { adx: rma(dx, n), plusDI, minusDI };
  }

  function mfi(bars, n) {
    const tp = hlc3(bars), len = bars.length, out = filled(len);
    const pos = filled(len), neg = filled(len);
    for (let i = 1; i < len; i++) {
      const flow = tp[i] * (bars[i].volume || 0);
      // An unchanged typical price counts toward neither side.
      pos[i] = tp[i] > tp[i - 1] ? flow : 0;
      neg[i] = tp[i] < tp[i - 1] ? flow : 0;
    }
    let sp = 0, sn = 0;
    for (let i = 1; i < len; i++) {
      sp += pos[i]; sn += neg[i];
      if (i > n) { sp -= pos[i - n]; sn -= neg[i - n]; }
      // Same 0/0 convention as rsi(): no flow either way is neutral, not 100.
      if (i >= n) out[i] = (sp === 0 && sn === 0) ? 50
        : sn === 0 ? 100 : sp === 0 ? 0 : 100 - 100 / (1 + sp / sn);
    }
    return out;
  }

  function cmf(bars, n) {
    const len = bars.length, out = filled(len);
    let sMfv = 0, sVol = 0;
    const mfv = bars.map(b => {
      const rng = b.high - b.low;
      return rng === 0 ? 0 : ((b.close - b.low) - (b.high - b.close)) / rng * (b.volume || 0);
    });
    for (let i = 0; i < len; i++) {
      sMfv += mfv[i]; sVol += bars[i].volume || 0;
      if (i >= n) { sMfv -= mfv[i - n]; sVol -= bars[i - n].volume || 0; }
      if (i >= n - 1) out[i] = sVol > 0 ? sMfv / sVol : null;
    }
    return out;
  }

  function obv(bars) {
    let v = 0;
    return bars.map((b, i) => {
      if (i > 0) {
        if (b.close > bars[i - 1].close) v += (b.volume || 0);
        else if (b.close < bars[i - 1].close) v -= (b.volume || 0);
      }
      return v;
    });
  }

  function vpt(bars) {
    const out = [0];
    for (let i = 1; i < bars.length; i++) {
      const pc = bars[i - 1].close;
      out.push(out[i - 1] + (pc > 0 ? (bars[i].volume || 0) * ((bars[i].close - pc) / pc) : 0));
    }
    return out;
  }

  function trix(src, n) {
    const e3 = ema(ema(ema(src, n), n), n);
    return e3.map((v, i) =>
      (i > 0 && v !== null && e3[i - 1] !== null && e3[i - 1] !== 0) ? (v - e3[i - 1]) / e3[i - 1] * 100 : null);
  }

  function aroon(bars, n) {
    const len = bars.length, up = filled(len), down = filled(len);
    const hi = col(bars, 'high'), lo = col(bars, 'low');
    for (let i = n; i < len; i++) {
      let hIdx = i - n, lIdx = i - n;
      for (let j = i - n; j <= i; j++) {
        if (hi[j] >= hi[hIdx]) hIdx = j;
        if (lo[j] <= lo[lIdx]) lIdx = j;
      }
      up[i]   = (n - (i - hIdx)) / n * 100;
      down[i] = (n - (i - lIdx)) / n * 100;
    }
    return { up, down };
  }

  // DPO = price shifted back (n/2+1) bars, minus the current SMA(n).
  function dpo(src, n) {
    const ma = sma(src, n), shift = Math.floor(n / 2) + 1;
    return src.map((_, i) => (i >= shift && ma[i] !== null && isNum(src[i - shift])) ? src[i - shift] - ma[i] : null);
  }

  function ultimateOsc(bars, fast, mid, slow) {
    const len = bars.length;
    const bp = filled(len), tr = filled(len);
    for (let i = 1; i < len; i++) {
      const pc = bars[i - 1].close;
      bp[i] = bars[i].close - Math.min(bars[i].low, pc);
      tr[i] = Math.max(bars[i].high, pc) - Math.min(bars[i].low, pc);
    }
    const roll = (arr, n) => {
      const o = filled(len); let s = 0;
      for (let i = 1; i < len; i++) {
        s += arr[i];
        if (i > n) s -= arr[i - n];
        if (i >= n) o[i] = s;
      }
      return o;
    };
    const out = filled(len);
    const [bpF, bpM, bpS] = [roll(bp, fast), roll(bp, mid), roll(bp, slow)];
    const [trF, trM, trS] = [roll(tr, fast), roll(tr, mid), roll(tr, slow)];
    for (let i = slow; i < len; i++) {
      if (!trF[i] || !trM[i] || !trS[i]) continue;
      out[i] = 100 * (4 * (bpF[i] / trF[i]) + 2 * (bpM[i] / trM[i]) + (bpS[i] / trS[i])) / 7;
    }
    return out;
  }

  function elderRay(bars, n) {
    const e = ema(col(bars, 'close'), n);
    return {
      bull: bars.map((b, i) => e[i] !== null ? b.high - e[i] : null),
      bear: bars.map((b, i) => e[i] !== null ? b.low - e[i] : null),
    };
  }

  function ppo(src, fast, slow, sig) {
    const ef = ema(src, fast), es = ema(src, slow);
    const line = ef.map((v, i) => (v !== null && es[i] !== null && es[i] !== 0) ? (v - es[i]) / es[i] * 100 : null);
    const signal = ema(line, sig);
    return { line, signal, hist: line.map((v, i) => (v !== null && signal[i] !== null) ? v - signal[i] : null) };
  }

  const roc = (src, n) =>
    src.map((v, i) => (i >= n && isNum(v) && isNum(src[i - n]) && src[i - n] !== 0)
      ? (v - src[i - n]) / src[i - n] * 100 : null);

  const momentum = (src, n) =>
    src.map((v, i) => (i >= n && isNum(v) && isNum(src[i - n])) ? v - src[i - n] : null);

  /* ── Trend / overlay indicators ───────────────────────────────────── */

  // Wilder's Parabolic SAR. Trend seeded from the first two bars; SAR clamped
  // to the prior two bars' extremes; AF steps only on a new extreme point.
  function psar(bars, step = 0.02, maxStep = 0.2) {
    const len = bars.length;
    if (len < 2) return filled(len).map((_, i) => ({ time: bars[i]?.time, value: null, rising: true }));
    const out = new Array(len);
    let rising = bars[1].close >= bars[0].close;
    let af = step;
    let ep  = rising ? bars[0].high : bars[0].low;
    let sar = rising ? bars[0].low  : bars[0].high;
    out[0] = { time: bars[0].time, value: sar, rising };
    for (let i = 1; i < len; i++) {
      const b = bars[i];
      sar = sar + af * (ep - sar);
      // SAR may not penetrate the prior two bars' range.
      if (rising) {
        sar = Math.min(sar, bars[i - 1].low, i >= 2 ? bars[i - 2].low : bars[i - 1].low);
      } else {
        sar = Math.max(sar, bars[i - 1].high, i >= 2 ? bars[i - 2].high : bars[i - 1].high);
      }
      // Reversal test against the current bar.
      if (rising && b.low < sar) {
        rising = false; sar = ep; ep = b.low; af = step;
      } else if (!rising && b.high > sar) {
        rising = true; sar = ep; ep = b.high; af = step;
      } else if (rising && b.high > ep) {
        ep = b.high; af = Math.min(af + step, maxStep);
      } else if (!rising && b.low < ep) {
        ep = b.low; af = Math.min(af + step, maxStep);
      }
      out[i] = { time: b.time, value: sar, rising };
    }
    return out;
  }

  // Supertrend, matching Pine's reference implementation. The band ratchet
  // tests the PREVIOUS close against the PREVIOUS band — using the current
  // close makes the bands jitter and flips fire a bar early.
  function supertrend(bars, atrPeriod = 10, mult = 3) {
    const a = atr(bars, atrPeriod), mid = hl2(bars), len = bars.length;
    const out = new Array(len);
    let prevUpper = null, prevLower = null, trend = 1;
    for (let i = 0; i < len; i++) {
      if (a[i] === null) { out[i] = { time: bars[i].time, value: null, trend: 1 }; continue; }
      let upper = mid[i] + mult * a[i];   // resistance band, active while trend is down
      let lower = mid[i] - mult * a[i];   // support band, active while trend is up
      if (prevLower !== null) {
        const pc = bars[i - 1].close;
        lower = (pc > prevLower) ? Math.max(lower, prevLower) : lower;
        upper = (pc < prevUpper) ? Math.min(upper, prevUpper) : upper;
        trend = (trend === -1 && bars[i].close > prevUpper) ? 1
              : (trend === 1 && bars[i].close < prevLower) ? -1
              : trend;
      } else {
        trend = 1;
      }
      prevUpper = upper; prevLower = lower;
      out[i] = { time: bars[i].time, value: trend === 1 ? lower : upper, trend };
    }
    return out;
  }

  // Ichimoku with its real displacement: the cloud is projected `kijun` bars
  // into the future and Chikou is plotted `kijun` bars back. Drawing them
  // unshifted (as most quick implementations do) puts the cloud in the wrong
  // place entirely and destroys the indicator's meaning.
  function ichimoku(bars, tenkanP = 9, kijunP = 26, senkouP = 52) {
    const hi = col(bars, 'high'), lo = col(bars, 'low');
    const avg = n => {
      const h = highest(hi, n), l = lowest(lo, n);
      return h.map((v, i) => (v !== null && l[i] !== null) ? (v + l[i]) / 2 : null);
    };
    const tenkan = avg(tenkanP), kijun = avg(kijunP);
    const senkouA = tenkan.map((v, i) => (v !== null && kijun[i] !== null) ? (v + kijun[i]) / 2 : null);
    const senkouB = avg(senkouP);
    const chikou = bars.map((_, i) => (i + kijunP < bars.length) ? bars[i + kijunP].close : null);
    return { tenkan, kijun, senkouA, senkouB, chikou, displacement: kijunP };
  }

  /* ── Session-anchored calculations ────────────────────────────────────
     VWAP is defined over a *session*. Accumulating it across the whole
     fetched history (60 days of 5-minute bars, say) produces a number that
     means nothing. `sessionKey` marks where to reset. */
  function vwap(bars, sessionKey) {
    const out = filled(bars.length);
    let cumPV = 0, cumV = 0, key = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const k = sessionKey ? sessionKey(b, i) : 0;
      if (k !== key) { cumPV = 0; cumV = 0; key = k; }
      const v = b.volume || 0;
      cumPV += ((b.high + b.low + b.close) / 3) * v;
      cumV += v;
      out[i] = cumV > 0 ? cumPV / cumV : (i > 0 ? out[i - 1] : null);
    }
    return out;
  }

  // Classic floor-trader pivots, derived from the PREVIOUS completed period's
  // HLC and held flat across the following period. Deriving them from the
  // current (incomplete) bar — as the old build did — is circular.
  function pivotPoints(bars, periodKey) {
    const out = filled(bars.length);
    let key = null, agg = null, prev = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const k = periodKey(b, i);
      if (k !== key) {
        if (agg) prev = agg;
        key = k;
        agg = { high: b.high, low: b.low, close: b.close };
      } else {
        agg.high = Math.max(agg.high, b.high);
        agg.low = Math.min(agg.low, b.low);
        agg.close = b.close;
      }
      if (prev) {
        const pp = (prev.high + prev.low + prev.close) / 3, rng = prev.high - prev.low;
        out[i] = {
          pp,
          r1: 2 * pp - prev.low,  r2: pp + rng,  r3: prev.high + 2 * (pp - prev.low),
          s1: 2 * pp - prev.high, s2: pp - rng,  s3: prev.low - 2 * (prev.high - pp),
        };
      }
    }
    return out;
  }

  /* ── Bar transforms ───────────────────────────────────────────────── */
  function heikinAshi(bars) {
    const out = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], p = out[i - 1];
      const close = (b.open + b.high + b.low + b.close) / 4;
      const open = p ? (p.open + p.close) / 2 : (b.open + b.close) / 2;
      out[i] = {
        time: b.time, open, close,
        high: Math.max(b.high, open, close),
        low:  Math.min(b.low, open, close),
        volume: b.volume,
      };
    }
    return out;
  }

  // Renko bricks. Every brick carries a distinct, strictly increasing time so
  // the renderer can plot them; bricks are only emitted on a full box move.
  function renko(bars, boxSize) {
    if (!bars.length || !(boxSize > 0)) return [];
    const out = [];
    let base = Math.round(bars[0].close / boxSize) * boxSize;
    let t = bars[0].time - 1;
    for (const b of bars) {
      while (b.close >= base + boxSize) {
        t = Math.max(t + 1, b.time);
        out.push({ time: t, open: base, high: base + boxSize, low: base, close: base + boxSize, volume: 0 });
        base += boxSize;
      }
      while (b.close <= base - boxSize) {
        t = Math.max(t + 1, b.time);
        out.push({ time: t, open: base, high: base, low: base - boxSize, close: base - boxSize, volume: 0 });
        base -= boxSize;
      }
    }
    return out;
  }

  function lineBreak(bars, n) {
    if (!bars.length) return [];
    const out = [{ ...bars[0] }];
    let t = bars[0].time;
    for (let i = 1; i < bars.length; i++) {
      const recent = out.slice(-n);
      let maxH = -Infinity, minL = Infinity;
      for (const r of recent) {
        maxH = Math.max(maxH, r.open, r.close);
        minL = Math.min(minL, r.open, r.close);
      }
      const c = bars[i].close, prevClose = out[out.length - 1].close;
      if (c > maxH || c < minL) {
        t = Math.max(t + 1, bars[i].time);
        out.push(c > maxH
          ? { time: t, open: prevClose, high: c, low: prevClose, close: c, volume: 0 }
          : { time: t, open: prevClose, high: prevClose, low: c, close: c, volume: 0 });
      }
    }
    return out;
  }

  return {
    isNum, sma, ema, rma, wma, stdev, highest, lowest, change,
    col, hl2, hlc3, ohlc4, source, trueRange,
    dema, tema, hma, zlema, alma, vwma,
    atr, bollinger, keltner, donchian, envelope, chop,
    rsi, macd, stoch, stochRsi, cci, williamsR, adx, mfi, cmf, obv, vpt,
    trix, aroon, dpo, ultimateOsc, elderRay, ppo, roc, momentum,
    psar, supertrend, ichimoku, vwap, pivotPoints,
    heikinAshi, renko, lineBreak,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TA;
