
/* Push for a better return-per-drawdown ratio. */
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const ETFS = Object.keys(E).filter(s => E[s].c && E[s].c.length === N);
const ED = s => series(s).daily;
const gldD = ED('GLD'), iefD = ED('IEF'), bilD = ED('BIL');
const mixW = parts => { const cs = parts.map(p => p.d); let v = parts.map(p => p.w); const out = [1];
  for (let k = 1; k < cs[0].length; k++) { v = v.map((x, j) => x * cs[j][k] / cs[j][k - 1]); const t = v.reduce((a, b) => a + b, 0); if (REB.has(first0 + k)) v = parts.map(p => p.w * t * (1 - 0.0002)); out.push(t); } return out; };
const lever = (d, L) => { const o = [1]; let v = 1; for (let k = 1; k < d.length; k++) { const r = d[k] / d[k - 1] - 1, b = bilD[k] / bilD[k - 1] - 1 + 0.02 / 252; v *= 1 + L * r - (L - 1) * b; o.push(Math.max(v, 1e-9)); } return o; };
// ETF trend/rotation sleeve: at each rebalance, rank ETFs by (6-1 month return), keep those above their 200-day average, hold top n equally; empty slots -> T-bills (BIL)
const etfSleeve = (pool, n, look = 126, skip = 21) => { const out = [1]; let w = new Map(); let v = 1;
  for (let k = 1; k < N - first0; k++) { const i = first0 + k; let r = 0, inv = 0; for (const [s, x] of w) { r += x * (E[s].c[i] / E[s].c[i - 1] - 1); inv += x; } r += (1 - inv) * (E.BIL.c[i] / E.BIL.c[i - 1] - 1); v *= 1 + r; out.push(v);
    if (REB.has(i + 1)) { const sc = []; for (const s of pool) { const c = E[s].c; if (!(c[i - look] > 0)) continue; let m = 0; for (let j = i - 199; j <= i; j++) m += c[j]; m /= 200; if (c[i] < m) continue; sc.push([s, c[i - skip] / c[i - look] - 1]); }
      sc.sort((a, b) => b[1] - a[1]); const pick = sc.slice(0, n).filter(([, m]) => m > 0); const nw = new Map(pick.map(([s]) => [s, 1 / n]));
      let turn = 0; for (const s of new Set([...w.keys(), ...nw.keys()])) turn += Math.abs((nw.get(s) || 0) - (w.get(s) || 0)); v *= 1 - turn * 0.0005; w = nw; } }
  return out; };
// ensemble momentum score: average percentile of several lookbacks (within the liquid 300), industry filter kept
for (const [, rows] of snap) { const liq = rows.filter(r => r.rank < 300 && r.f.IND != null);
  const pr = key => { const h = liq.filter(r => r.f[key] != null && isFinite(r.f[key])).sort((a, b) => a.f[key] - b.f[key]); h.forEach((r, n) => { (r.q2 ||= {})[key] = n / Math.max(1, h.length - 1); }); };
  for (const key of ['smoothMom', 's6', 's9', 's3']) pr(key);
  for (const r of rows) { const q = r.q2; r.f.ENS = r.f.IND != null && q ? (q.smoothMom + (q.s9 ?? .5) + (q.s6 ?? .5)) / 3 : null; r.f.ENS4 = r.f.IND != null && q ? (q.smoothMom + (q.s9 ?? .5) + (q.s6 ?? .5) + (q.s3 ?? .5)) / 4 : null; } }

const RES = {}, CORR = {};
const corr = (a, b) => { const x = [], y = []; for (let k = 5; k < a.length; k += 5) { x.push(a[k] / a[k - 5] - 1); y.push(b[k] / b[k - 5] - 1); } const mx = x.reduce((p, q) => p + q, 0) / x.length, my = y.reduce((p, q) => p + q, 0) / y.length; let sxy = 0, sxx = 0, syy = 0; x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sxx += (v - mx) ** 2; syy += (y[i] - my) ** 2; }); return sxy / Math.sqrt(sxx * syy); };
const SECT = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'].filter(s => ETFS.includes(s));
const ALL = ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'TLT', 'IEF', 'GLD', ...SECT].filter(s => ETFS.includes(s));
for (const [sn, os] of Object.entries({ A: [0, 5, 10, 15], B: [2, 7, 12, 17] })) {
  setMulti(os); const S_ = cfg => simulate(cfg).daily;
  const M = S_(B('IND')), ME = S_(B('ENS')), ME4 = S_(B('ENS4')), LV = S_(B('LOWV', { wfun: eqW }));
  const T3 = etfSleeve(ALL, 3), T4 = etfSleeve(ALL, 4), TS = etfSleeve([...SECT, 'TLT', 'IEF', 'GLD'], 3), TA = etfSleeve(['SPY', 'QQQ', 'EFA', 'EEM', 'TLT', 'IEF', 'GLD'], 2);
  if (sn === 'A') { CORR['momentum vs low-vol'] = corr(M, LV); CORR['momentum vs ETF trend (top 3)'] = corr(M, T3); CORR['momentum vs gold'] = corr(M, gldD); CORR['momentum vs bonds'] = corr(M, iefD); CORR['low-vol vs ETF trend'] = corr(LV, T3); }
  const C = {
    'momentum (current)': M, 'momentum, 3-lookback blend': ME, 'momentum, 4-lookback blend': ME4,
    'ETF trend: top 3 of all ETFs': T3, 'ETF trend: top 4 of all ETFs': T4, 'ETF trend: top 3 sectors/bonds/gold': TS, 'ETF trend: top 2 asset classes': TA,
    '35 mom / 35 low-vol / 15 IEF / 15 gold (last best)': mixW([{ d: M, w: .35 }, { d: LV, w: .35 }, { d: iefD, w: .15 }, { d: gldD, w: .15 }]),
    '35 mom / 35 low-vol / 30 ETF trend': mixW([{ d: M, w: .35 }, { d: LV, w: .35 }, { d: T3, w: .3 }]),
    '40 mom / 30 low-vol / 30 ETF trend': mixW([{ d: M, w: .4 }, { d: LV, w: .3 }, { d: T3, w: .3 }]),
    '35 mom / 30 low-vol / 20 ETF trend / 15 gold': mixW([{ d: M, w: .35 }, { d: LV, w: .3 }, { d: T3, w: .2 }, { d: gldD, w: .15 }]),
    '35 mom-blend / 35 low-vol / 15 IEF / 15 gold': mixW([{ d: ME, w: .35 }, { d: LV, w: .35 }, { d: iefD, w: .15 }, { d: gldD, w: .15 }]),
    '30 mom / 30 low-vol / 20 ETF trend / 10 IEF / 10 gold': mixW([{ d: M, w: .3 }, { d: LV, w: .3 }, { d: T3, w: .2 }, { d: iefD, w: .1 }, { d: gldD, w: .1 }]),
    '50 mom / 50 ETF trend': mixW([{ d: M, w: .5 }, { d: T3, w: .5 }]),
  };
  for (const [nm, d] of Object.entries(C)) { const s = stats(d, first0, R), pre = stats(d, first0, ['2018-01-01', '2023-12-31']); (RES[nm] ||= {})[sn] = { ...s, pre, d }; } }
setOff(0);
console.log('weekly-return correlations (1 = move together, 0 = unrelated):', Object.entries(CORR).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' | '), '\n');
const rows = Object.entries(RES).map(([nm, v]) => ({ nm, yr: (v.A.cagr + v.B.cagr) / 2, dd: Math.max(v.A.dd, v.B.dd), sh: (v.A.sharpe + v.B.sharpe) / 2, pre: v.A.pre, v })).sort((a, b) => b.yr / b.dd - a.yr / a.dd);
for (const r of rows) console.log(`${r.nm.padEnd(52)} yr ${pct(r.yr)} | worst drop ${pct(-r.dd)} | ret/drop ${(r.yr / r.dd).toFixed(2)} | Sharpe ${r.sh.toFixed(2)} | 2018-23 ${pct(r.pre.cagr)}`);
// leverage the best 3 ratios to a -20% worst drop
console.log('\nLEVERAGE the best mixes until the worst drop is about -20% (borrow cost = T-bills + 2%/yr):');
for (const r of rows.filter(x => !x.nm.startsWith('momentum')).slice(0, 4)) { let best = null; for (let L = 1; L <= 3.001; L += 0.05) { const a = stats(lever(r.v.A.d, L), first0, R), b = stats(lever(r.v.B.d, L), first0, R); if (Math.max(a.dd, b.dd) <= 0.205) best = { L, yr: (a.cagr + b.cagr) / 2, dd: Math.max(a.dd, b.dd) }; }
  if (best) console.log(`${r.nm.padEnd(52)} ${best.L.toFixed(2)}x -> yr ${pct(best.yr)} | worst drop ${pct(-best.dd)}`); else console.log(`${r.nm.padEnd(52)} even 1x is deeper than -20%`); }
