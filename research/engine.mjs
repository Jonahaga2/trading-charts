// The strategy tournament.
// Data: stk-all (every listed stock incl. delisted, 2016→), etf.json (SPY, BIL),
//       sec-facts.json (point-in-time fundamentals, optional).
// Each month-end: score every stock with each signal (data ≤ that day only);
// hold the top 20 of a size bucket, equal weight, trade at next open.
// Exits: monthly only, or stop / take-profit / trailing overlays checked on
// closes and executed at the next open. Cash earns T-bills.
// Periods: EXPLORE 2017–2021 · VALIDATE 2022–2023 · HOLDOUT 2024→.
// A strategy survives only if it beats SPY on Sharpe and stays within 2%/yr
// of SPY's return in all three, AND its explore Sharpe beats the best of an
// equal number of random-pick strategies (the luck benchmark).
import fs from 'node:fs';
import path from 'node:path';
const S = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const E = JSON.parse(fs.readFileSync(path.join(S, 'etf.json'), 'utf8'));
const days = E.SPY.t, N = days.length, dayIdx = new Map(days.map((d, i) => [d, i]));
const t0 = Date.now();

/* ── Load stocks onto the SPY calendar ── */
const syms = [], O = [], H = [], L = [], C = [], V = [];
for (const f of fs.readdirSync(path.join(S, 'stk-all'))) {
  const data = JSON.parse(fs.readFileSync(path.join(S, 'stk-all', f), 'utf8'));
  for (const [s, d] of Object.entries(data)) {
    const o = new Float32Array(N).fill(NaN), h = new Float32Array(N).fill(NaN), l = new Float32Array(N).fill(NaN), c = new Float32Array(N).fill(NaN), v = new Float32Array(N).fill(0);
    d.t.forEach((t, k) => { const i = dayIdx.get(t); if (i != null) { o[i] = d.o[k]; h[i] = d.h[k]; l[i] = d.l[k]; c[i] = d.c[k]; v[i] = d.v[k]; } });
    syms.push(s); O.push(o); H.push(h); L.push(l); C.push(c); V.push(v);
  }
}
const NS = syms.length;
// As-traded closes, for price filters (adjusted prices carry later splits backwards).
const RAW = new Map();
if (fs.existsSync(path.join(S, 'stk-raw'))) for (const f of fs.readdirSync(path.join(S, 'stk-raw'))) {
  const data = JSON.parse(fs.readFileSync(path.join(S, 'stk-raw', f), 'utf8'));
  for (const [s, d] of Object.entries(data)) { const c = new Float32Array(N).fill(NaN); d.t.forEach((t, k) => { const i = dayIdx.get(t); if (i != null) c[i] = d.c[k]; }); RAW.set(s, c); }
}
const rawC = syms.map(s => RAW.get(s) || null);
console.error(`as-traded prices for ${rawC.filter(Boolean).length}/${NS}`);
console.error(`${NS} stocks loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

/* ── Fundamentals (optional): point-in-time lookups ── */
const SEC = !process.env.NOSEC && fs.existsSync(path.join(S, 'sec-facts.json')) ? JSON.parse(fs.readFileSync(path.join(S, 'sec-facts.json'), 'utf8')) : {};
const asOf = (list, day) => { let v = null; if (list) for (const x of list) { if (x.filed <= day) v = x; else break; } return v; };

/* ── Month-end features ── */
const monthEnds = []; for (let i = 260; i < N; i++) if (i === N - 1 || days[i + 1].slice(0, 7) !== days[i].slice(0, 7)) monthEnds.push(i);
const FEATS = ['momLowVol', 'momValue', 'momProfitable', 'valueProfitable', 'momTrend', 'mom12_1', 'smoothMom', 'near52wHigh', 'reversal1m', 'lowVol', 'antiLottery', 'volSurge', 'obvTrend', 'closeLocation', 'gapUps', 'trend200', 'gain1y', 'dipFrom3mHigh',
  'earningsYield', 'dividendYield', 'smallFloat', 'bigFloat'];
const snap = new Map();          // month-end i → [{ k, dv, mcap, f: {...} }]
const SIGDAYS=[...new Set(monthEnds.flatMap(i=>[i,i-5,i-10,i-15]))].sort((x,y)=>x-y);
for (const i of SIGDAYS) {
  const rows = [], day = days[i];
  for (let k = 0; k < NS; k++) {
    const c = C[k], h = H[k], l = L[k], o = O[k], v = V[k];
    if (!rawC[k] || !(rawC[k][i] >= 3) || isNaN(c[i - 252]) || isNaN(c[i - 21])) continue;   // $3+ as actually traded
    let onS = 0, inS = 0, on21 = 0, on5 = 0, s50 = 0, n50 = 0, hi20 = 0, n = 0, sum = 0, sum2 = 0, dv60 = 0, n60 = 0, dv20 = 0, dv120 = 0, maxH = 0, maxR21 = 0, obv = 0, vtot = 0, clv = 0, nclv = 0, gaps = 0, s200 = 0, n200 = 0, bad = false, sum63 = 0, sum63sq = 0, n63 = 0, max63 = 0;
    for (let j = i - 251; j <= i; j++) {
      if (isNaN(c[j]) || isNaN(c[j - 1])) continue;
      const r = c[j] / c[j - 1];
      if (r > 3 || r < 1 / 3) { bad = true; break; }
      const lr = Math.log(r); n++; sum += lr; sum2 += lr * lr;
      if (h[j] > maxH) maxH = h[j];
      const d$ = c[j] * v[j];
      if (j > i - 60) { dv60 += d$; n60++; }
      if (j > i - 20) dv20 += d$;
      if (j > i - 120) dv120 += d$;
      if (j > i - 21 && r - 1 > maxR21) maxR21 = r - 1;
      if (j > i - 63) { obv += Math.sign(lr) * v[j]; vtot += v[j]; sum63 += lr; sum63sq += lr * lr; n63++; if (h[j] > max63) max63 = h[j]; if (o[j] > h[j - 1]) gaps++; }
      if (j > i - 21 && h[j] > l[j]) { clv += ((c[j] - l[j]) - (h[j] - c[j])) / (h[j] - l[j]); nclv++; }
      if (!isNaN(o[j]) && o[j] > 0) { const g = Math.log(o[j] / c[j - 1]), d = Math.log(c[j] / o[j]); if (j <= i - 21) { onS += g; inS += d; } if (j > i - 21) on21 += g; if (j > i - 5) on5 += g; }
      if (j > i - 200) { s200 += c[j]; n200++; } if (j > i - 50) { s50 += c[j]; n50++; } if (j > i - 20 && c[j] > hi20) hi20 = c[j];
    }
    if (bad || n < 230 || n60 < 40) continue;
    const vol = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2) * 252), vol63 = Math.sqrt(Math.max(0, sum63sq / n63 - (sum63 / n63) ** 2) * 252);
    const mom = c[i - 21] / c[i - 252] - 1;
    const f = {
      mom12_1: mom, smoothMom: mom / (vol || 1), near52wHigh: c[i] / maxH, reversal1m: -(c[i] / c[i - 21] - 1), lowVol: -vol63, antiLottery: -maxR21,
      volSurge: dv20 / 20 / (dv120 / 120 || 1), obvTrend: obv / (vtot || 1), closeLocation: clv / (nclv || 1), gapUps: gaps, trend200: c[i] / (s200 / n200) - 1,
      gain1y: c[i] / c[i - 252] - 1, onMom: onS / (vol || 1), inMom: inS / (vol || 1), on21, on5, onShare: onS - inS, s6: (c[i - 21] / c[i - 126] - 1) / (vol || 1), s3: (c[i - 5] / c[i - 63] - 1) / (vol || 1), s9: (c[i - 21] / c[i - 189] - 1) / (vol || 1), sma50r: c[i] / (s50 / n50) - 1, golden: (s50 / n50) / (s200 / n200) - 1, dip20: 1 - c[i] / hi20, ret5: c[i] / c[i - 5] - 1, dipFrom3mHigh: -(c[i] / max63 - 1),
    };
    // Fundamentals, as filed by this day.
    let mcap = NaN;
    const fx = SEC[syms[k]];
    if (fx) {
      const sh = asOf(fx.shares, day), ni = asOf(fx.ni, day), dvd = asOf(fx.div, day), fl = asOf(fx.float, day);
      if (sh && rawC[k]) mcap = sh.val * rawC[k][i];   // shares as filed × the price actually traded that day
      if (ni && mcap > 0) f.earningsYield = ni.val / mcap;
      if (dvd && mcap > 0) f.dividendYield = dvd.val / mcap;
      if (fl) { f.smallFloat = -fl.val; f.bigFloat = fl.val; }
    }
    { // ADX & ATR (Wilder, 14) over the last 120 days
      let tr14 = 0, p14 = 0, m14 = 0, adx = 0, nd = 0, ok = true; const P = 14;
      for (let j = i - 119; j <= i; j++) { if (isNaN(h[j]) || isNaN(h[j - 1])) { ok = false; break; }
        const tr = Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1])), up = h[j] - h[j - 1], dn = l[j - 1] - l[j];
        const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
        tr14 = tr14 - tr14 / P + tr; p14 = p14 - p14 / P + pdm; m14 = m14 - m14 / P + mdm;
        const pdi = p14 / tr14, mdi = m14 / tr14, dx = (pdi + mdi) ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
        nd++; adx = nd <= P ? adx + dx / P : adx - adx / P + dx / P; }
      if (ok) { f.adx = adx; f.atr = tr14 / P / c[i]; }
      let e = c[i - 251], e21 = null; const al = 2 / 201; for (let j = i - 250; j <= i; j++) { if (!isNaN(c[j])) e = e + al * (c[j] - e); if (j === i - 21) e21 = e; }
      f.emaSlope = e / e21 - 1;
      f.ret3y = i >= 756 && !isNaN(c[i - 756]) ? c[i - 252] / c[i - 756] - 1 : null;
    }
    rows.push({ k, dv: dv60 / n60, mcap, f });
  }
  rows.sort((a, b) => b.dv - a.dv);
  rows.forEach((r, rank) => { r.rank = rank; });
  // Percentile ranks this month (0 worst … 1 best) for blending.
  const pctRank = key => { const have = rows.filter(r => r.f[key] != null && isFinite(r.f[key])).sort((a, b) => a.f[key] - b.f[key]); have.forEach((r, n) => { (r.p ||= {})[key] = n / Math.max(1, have.length - 1); }); };
  for (const key of ['smoothMom', 'lowVol', 'earningsYield', 'trend200']) pctRank(key);
  for (const r of rows) {
    const q = r.p || {};
    if (q.smoothMom != null && q.lowVol != null) r.f.momLowVol = q.smoothMom + q.lowVol;
    if (q.smoothMom != null && q.earningsYield != null) r.f.momValue = q.smoothMom + q.earningsYield;
    if (r.f.earningsYield != null) {
      r.f.momProfitable = r.f.earningsYield > 0 ? r.f.smoothMom : null;
      r.f.valueProfitable = r.f.earningsYield > 0 ? r.f.earningsYield : null;
    }
    if (q.smoothMom != null && q.trend200 != null) r.f.momTrend = q.smoothMom + q.trend200;
  }
  snap.set(i, rows);
}
console.error(`features for ${monthEnds.length} months in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

/* ── Simulation ── */
// Size by dollar-volume rank, and (with SEC data) by market value at the time.
const BUCKETS = {
  large: { ok: r => r.rank < 300, cost: 0.0005 }, mid1000: { ok: r => r.rank >= 300 && r.rank < 1000, cost: 0.002 }, top1000: { ok: r => r.rank < 1000, cost: 0.001 }, mid: { ok: r => r.rank >= 300 && r.rank < 1000, cost: 0.001 }, small: { ok: r => r.rank >= 1000 && r.rank < 2500, cost: 0.0025 },
  ...(process.env.NOSEC ? {} : {
    capLarge: { ok: r => r.mcap > 10e9, cost: 0.0005 }, capMid: { ok: r => r.mcap > 2e9 && r.mcap <= 10e9, cost: 0.001 }, capSmall: { ok: r => r.mcap > 3e8 && r.mcap <= 2e9, cost: 0.0025 },
  }),
};
const bilC = E.BIL.c, bilO = E.BIL.o;
let REB=new Map(); const setMulti=os=>{REB=new Map(monthEnds.flatMap(i=>os.map(o=>[i-o+1,i-o])).filter(([j])=>j<N));}; const setOff=o=>{REB=new Map(monthEnds.map(i=>[i-o+1,i-o]).filter(([j])=>j<N));}; setOff(0); const rebalAt={has:j=>REB.has(j)};
const PS = new Map(); const sma = (k, i, n) => { let ps = PS.get(k); if (!ps) { ps = new Float64Array(N + 1); let last = 0; for (let j = 0; j < N; j++) { if (!isNaN(C[k][j])) last = C[k][j]; ps[j + 1] = ps[j] + last; } PS.set(k, ps); } return (ps[i + 1] - ps[i + 1 - n]) / n; };
function simulate({ feat, bucket, exit = {}, random = null, top = 20, wfun = null }) {
  const { ok: inBucket, cost } = BUCKETS[bucket];
  let cash = 1 / bilO[monthEnds[0] + 1], pos = [];   // cash in BIL units; pos: { k, q, entry, peak, out }
  const first = monthEnds[0] + 1, daily = [];
  for (let i = first; i < N; i++) {
    // Delisted today: out at its last close.
    for (const p of pos) if (!p.out && isNaN(O[p.k][i])) { let j = i - 1; while (j > 0 && isNaN(C[p.k][j])) j--; cash += p.q * C[p.k][j] * (1 - cost) / bilO[i]; p.out = true; }
    // Overlay exits decided on yesterday's close, executed at today's open.
    if (exit.type && !rebalAt.has(i)) for (const p of pos) {
      if (p.out) continue;
      const cy = C[p.k][i - 1]; if (isNaN(cy)) continue;
      p.peak = Math.max(p.peak, cy);
      if (exit.half && !p.half && cy > p.entry * (1 + exit.half) && !isNaN(O[p.k][i])) { cash += p.q / 2 * O[p.k][i] * (1 - cost) / bilO[i]; p.q /= 2; p.half = true; }
      const hit = (exit.stop && cy < p.entry * (1 - exit.stop)) || (exit.take && cy > p.entry * (1 + exit.take)) || (exit.trail && cy < p.peak * (1 - exit.trail)) || (exit.atrMult && cy < p.entry * (1 - exit.atrMult * p.atr)) || (exit.be && p.peak > p.entry * (1 + exit.be) && cy < p.entry * (1 + (exit.beLock || 0))) || (exit.ma && cy < sma(p.k, i - 1, exit.ma));
      if (hit && !isNaN(O[p.k][i])) { cash += p.q * O[p.k][i] * (1 - cost) / bilO[i]; p.out = true; }
    }
    if (rebalAt.has(i)) {
      const rows = snap.get(REB.get(i)).filter(r => inBucket(r) && !isNaN(O[r.k][i]));
      let picks;
      if (random) { const u = [...rows]; for (let a = u.length - 1; a > 0; a--) { const b = Math.floor(random() * (a + 1)); [u[a], u[b]] = [u[b], u[a]]; } picks = u.slice(0, top); }
      else picks = rows.filter(r => r.f[feat] != null && isFinite(r.f[feat])).sort((a, b) => b.f[feat] - a.f[feat]).slice(0, top);
      let V0 = cash * bilO[i]; for (const p of pos) if (!p.out) V0 += p.q * O[p.k][i];
      const wts = wfun ? wfun(picks) : picks.map(() => 1 / Math.max(top, picks.length)); const atrOf = new Map(picks.map(r => [r.k, r.f.atr || 0]));
      const want = new Map(picks.map((r, n) => [r.k, V0 * wts[n] / O[r.k][i]]));
      let traded = 0;
      for (const p of pos) if (!p.out) traded += Math.abs((want.get(p.k) || 0) - p.q) * O[p.k][i], want.has(p.k) || 0;
      for (const [k, q] of want) if (!pos.some(p => !p.out && p.k === k)) traded += q * O[k][i];
      const fees = traded * cost;
      pos = [...want].map(([k, q]) => ({ k, q, entry: O[k][i], peak: O[k][i], out: false, atr: atrOf.get(k) || 0 }));
      const spent = pos.reduce((a, p) => a + p.q * O[p.k][i], 0);
      cash = (V0 - spent - fees) / bilO[i];
    }
    let v = cash * bilC[i]; for (const p of pos) if (!p.out) v += p.q * (isNaN(C[p.k][i]) ? p.entry : C[p.k][i]);
    daily.push(v);
  }
  return { daily, first };
}
const PERIODS = { explore: ['2017-01-01', '2021-12-31'], validate: ['2022-01-01', '2023-12-31'], holdout: ['2024-01-01', '2099'] };
function stats(daily, first, [a, b]) {
  let s = -1, e = -1;
  for (let k = 0; k < daily.length; k++) { const d = days[first + k]; if (d >= a && s < 0) s = k; if (d <= b) e = k; }
  if (s < 0 || e <= s) return null;
  const r = []; for (let k = s + 1; k <= e; k++) r.push(daily[k] / daily[k - 1] - 1);
  const mu = r.reduce((x, y) => x + y, 0) / r.length, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / r.length);
  let pk = daily[s], dd = 0; for (let k = s; k <= e; k++) { pk = Math.max(pk, daily[k]); dd = Math.max(dd, 1 - daily[k] / pk); }
  const yrs = (Date.parse(days[first + e]) - Date.parse(days[first + s])) / (365.25 * 864e5);
  return { cagr: (daily[e] / daily[s]) ** (1 / yrs) - 1, sharpe: mu / sd * Math.sqrt(252), dd };
}
const spyDaily = [], spyFirst = monthEnds[0] + 1; for (let i = spyFirst; i < N; i++) spyDaily.push(E.SPY.c[i]);
const SPY = Object.fromEntries(Object.entries(PERIODS).map(([p, r]) => [p, stats(spyDaily, spyFirst, r)]));

const pct = x => ((x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%').padStart(7);
const me = new Set(monthEnds), first0 = monthEnds[0] + 1;
const series = sym => { const out = []; for (let i = first0; i < N; i++) out.push(E[sym].c[i]); return { daily: out, first: first0 }; };
function mix(parts) { const ws = parts.map(p => p[1]), cs = parts.map(p => p[0].daily); let v = ws.slice(); const out = [1]; for (let k = 1; k < cs[0].length; k++) { v = v.map((x, j) => x * cs[j][k] / cs[j][k - 1]); const t = v.reduce((a, b) => a + b, 0); if (me.has(first0 + k)) v = ws.map(w => w * t); out.push(t); } return { daily: out, first: first0 }; }
const spy = series('SPY'), ief = series('IEF');
const R = ['2018-01-01', '2099'];
const show = (name, s) => console.log(`${name.padEnd(36)} ${pct(s.cagr)}  Sharpe ${s.sharpe.toFixed(2)}  DD ${pct(-s.dd)}`);



for (const [, rows] of snap) for (const r of rows) { const f = r.f; const ok = f.ret3y == null || f.ret3y < 2;
  for (const k of ['smoothMom', 's6', 's3', 's9']) f[k + 'R'] = f[k] != null && ok ? f[k] : null; }
const first = monthEnds[0] + 1;
const monthly = d => { const out = []; let prev = null; for (let k = 0; k < d.length; k++) { const i = first + k; if (me.has(i) && days[i] >= '2018') { if (prev != null) out.push(d[k] / prev - 1); prev = d[k]; } } return out; };
const SCHED = { monthly: [[0], [5], [10], [15]], '2x a month': [[0, 10], [5, 15]], weekly: [[0, 5, 10, 15]] };
const go = (nm, cfg, sched = 'monthly', momW = 1) => {
  const runs = SCHED[sched].map(os => { setMulti(os); const sim = simulate(cfg); return momW === 1 ? { daily: sim.daily } : mix([[sim, momW], [spy, (1 - momW) * 0.6], [ief, (1 - momW) * 0.4]]); });
  setOff(0);
  const st = runs.map(d => stats(d.daily, first0, R)), m = runs.flatMap(d => monthly(d.daily));
  const per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => runs.reduce((a, d) => a + stats(d.daily, first0, p).cagr, 0) / runs.length);
  console.log(`${nm.padEnd(44)} yr ${pct(st.reduce((a, s) => a + s.cagr, 0) / st.length)} | month avg ${pct(m.reduce((a, b) => a + b, 0) / m.length)} | ≥8%: ${String(Math.round(m.filter(x => x >= .08).length / m.length * 100)).padStart(2)}% ≤−8%: ${String(Math.round(m.filter(x => x <= -.08).length / m.length * 100)).padStart(2)}% | worstDD ${pct(-Math.max(...st.map(s => s.dd)))} | 18-21 ${pct(per[0])} 22-23 ${pct(per[1])} 24+ ${pct(per[2])}`);
};
const T = (o = {}) => ({ feat: 'smoothMomR', bucket: 'large', top: 10, ...o });

