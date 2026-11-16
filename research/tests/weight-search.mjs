
/* New sleeve (short-term reversal) + weight search chosen on 2018-21 only, checked on 2022+. */
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const ED = s => series(s).daily;
const gldD = ED('GLD'), iefD = ED('IEF'), tltD = ED('TLT'), bilD = ED('BIL'), spyD = ED('SPY');
for (const [, rows] of snap) for (const r of rows) { const f = r.f; f.REV = r.rank < 100 && f.ret5 != null ? -f.ret5 : null; f.REV300 = r.rank < 300 && f.ret5 != null ? -f.ret5 : null; f.REV1M = r.rank < 100 && f.reversal1m != null ? f.reversal1m : null; }
const port = (cs, w) => { let v = w.slice(); const out = [1]; for (let k = 1; k < cs[0].length; k++) { v = v.map((x, j) => x * cs[j][k] / cs[j][k - 1]); const t = v.reduce((a, b) => a + b, 0); out.push(t); if (REB.has(first0 + k + 1)) v = w.map(x => x * t * (1 - 0.0002)); } return out; };
const corr = (a, b) => { const x = [], y = []; for (let k = 5; k < a.length; k += 5) { x.push(a[k] / a[k - 5] - 1); y.push(b[k] / b[k - 5] - 1); } const mx = x.reduce((p, q) => p + q, 0) / x.length, my = y.reduce((p, q) => p + q, 0) / y.length; let sxy = 0, sxx = 0, syy = 0; x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sxx += (v - mx) ** 2; syy += (y[i] - my) ** 2; }); return sxy / Math.sqrt(sxx * syy); };
const SL = {};
for (const [sn, os] of Object.entries({ A: [0, 5, 10, 15], B: [2, 7, 12, 17] })) { setMulti(os);
  SL[sn] = { M: simulate(B('IND')).daily, LV: simulate(B('LOWV', { wfun: eqW })).daily, REV: simulate(B('REV', { wfun: eqW })).daily, REV300: simulate(B('REV300', { wfun: eqW })).daily, REV1M: simulate(B('REV1M', { wfun: eqW })).daily, IEF: iefD, GLD: gldD, TLT: tltD, SPY: spyD }; }
setMulti([0, 5, 10, 15]);
const showS = (nm, d) => { const s = stats(d, first0, R), a = stats(d, first0, ['2018-01-01', '2021-12-31']), b = stats(d, first0, ['2022-01-01', '2099']); console.log(`${nm.padEnd(40)} yr ${pct(s.cagr)} drop ${pct(-s.dd)} Sharpe ${s.sharpe.toFixed(2)} | 2018-21 ${pct(a.cagr)} | 2022+ ${pct(b.cagr)}`); };
console.log('NEW SLEEVES (days A):'); for (const k of ['REV', 'REV300', 'REV1M']) { showS(`${k} (buy last week's/month's losers)`, SL.A[k]); }
console.log('correlation with momentum: ' + ['LV', 'REV', 'REV300', 'REV1M', 'IEF', 'GLD', 'TLT', 'SPY'].map(k => `${k} ${corr(SL.A.M, SL.A[k]).toFixed(2)}`).join(' | '));
// weight grid, steps of 5%, sleeves M, LV, REV, IEF, GLD ; pick best ratio on 2018-21 (days A), with worst drop <= 20%
const keys = ['M', 'LV', 'REV', 'IEF', 'GLD'];
const cand = []; const st = 0.05;
for (let m = 0.2; m <= 0.6 + 1e-9; m += st) for (let lv = 0; lv <= 0.5 + 1e-9; lv += st) for (let rv = 0; rv <= 0.3 + 1e-9; rv += st) for (let ie = 0; ie <= 0.3 + 1e-9; ie += st) { const g = 1 - m - lv - rv - ie; if (g < -1e-9 || g > 0.3 + 1e-9) continue; cand.push([m, lv, rv, ie, Math.max(0, g)]); }
const scored = cand.map(w => { const d = port(keys.map(k => SL.A[k]), w), e = stats(d, first0, ['2018-01-01', '2021-12-31']); return { w, ex: e }; }).filter(x => x.ex.dd <= 0.2);
scored.sort((a, b) => b.ex.cagr / b.ex.dd - a.ex.cagr / a.ex.dd);
console.log(`\nweight mixes tried: ${cand.length}. Best by return/drop on 2018-21 ONLY, then checked on 2022+ and on days B:`);
for (const x of scored.slice(0, 8)) { const dA = port(keys.map(k => SL.A[k]), x.w), dB = port(keys.map(k => SL.B[k]), x.w); const f = stats(dA, first0, R), g = stats(dB, first0, R), h = stats(dA, first0, ['2022-01-01', '2099']);
  console.log(`${keys.map((k, i) => `${k} ${Math.round(x.w[i] * 100)}`).join(' / ').padEnd(40)} 2018-21 ${pct(x.ex.cagr)} drop ${pct(-x.ex.dd)} | 2022+ ${pct(h.cagr)} drop ${pct(-h.dd)} | full A ${pct(f.cagr)} ${pct(-f.dd)} | full B ${pct(g.cagr)} ${pct(-g.dd)}`); }
const ref = [0.35, 0.35, 0, 0.15, 0.15]; { const dA = port(keys.map(k => SL.A[k]), ref), dB = port(keys.map(k => SL.B[k]), ref); const f = stats(dA, first0, R), g = stats(dB, first0, R), h = stats(dA, first0, ['2022-01-01', '2099']), e = stats(dA, first0, ['2018-01-01', '2021-12-31']);
  console.log(`${'REF 35/35/0/15/15'.padEnd(40)} 2018-21 ${pct(e.cagr)} drop ${pct(-e.dd)} | 2022+ ${pct(h.cagr)} drop ${pct(-h.dd)} | full A ${pct(f.cagr)} ${pct(-f.dd)} | full B ${pct(g.cagr)} ${pct(-g.dd)}`); }
// best achievable return at <=20% drop on the FULL period (in-sample upper bound, for honesty)
const full = cand.map(w => { const a = stats(port(keys.map(k => SL.A[k]), w), first0, R), b = stats(port(keys.map(k => SL.B[k]), w), first0, R); return { w, yr: (a.cagr + b.cagr) / 2, dd: Math.max(a.dd, b.dd) }; }).filter(x => x.dd <= 0.2).sort((a, b) => b.yr - a.yr);
console.log(`\nUPPER BOUND (hindsight, full period, both day sets, drop <= 20%): best ${keys.map((k, i) => `${k} ${Math.round(full[0].w[i] * 100)}`).join(' / ')} -> ${pct(full[0].yr)}/yr, drop ${pct(-full[0].dd)}`);
