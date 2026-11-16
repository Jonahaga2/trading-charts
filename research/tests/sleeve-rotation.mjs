
/* Sleeve rotation (factor momentum): each week, tilt toward the sleeves that have done best lately. */
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const ED = s => series(s).daily;
const gldD = ED('GLD'), iefD = ED('IEF'), bilD = ED('BIL'), spyD = ED('SPY');
// generic weekly-reweighted portfolio of sleeves; wf(k) returns weights using data up to day k-1
const port = (cs, wf) => { let w = wf(1), v = w.slice(); const out = [1];
  for (let k = 1; k < cs[0].length; k++) { v = v.map((x, j) => x * cs[j][k] / cs[j][k - 1]); const t = v.reduce((a, b) => a + b, 0) + (1 - w.reduce((a, b) => a + b, 0)) * 0; out.push(t);
    if (REB.has(first0 + k + 1)) { const nw = wf(k); let turn = 0; nw.forEach((x, j) => turn += Math.abs(x - v[j] / t)); w = nw; v = w.map(x => x * t * (1 - turn * 0.0003)); } } return out; };
const ret = (d, k, n) => k > n ? d[k] / d[k - n] - 1 : 0;
const RES = {};
for (const [sn, os] of Object.entries({ A: [0, 5, 10, 15], B: [2, 7, 12, 17] })) {
  setMulti(os); const M = simulate(B('IND')).daily, LV = simulate(B('LOWV', { wfun: eqW })).daily;
  const S4 = [M, LV, iefD, gldD];
  const C = {};
  C['static 35/35/15/15 (last best)'] = port(S4, () => [.35, .35, .15, .15]);
  for (const n of [21, 63, 126]) {
    C[`tilt mom vs low-vol by ${n}d return (60/40 toward winner) + 15 IEF/15 gold`] = port(S4, k => ret(M, k, n) > ret(LV, k, n) ? [.42, .28, .15, .15] : [.28, .42, .15, .15]);
    C[`hold best 2 of 4 sleeves by ${n}d return`] = port(S4, k => { const r = S4.map(d => ret(d, k, n)), o = r.map((x, i) => i).sort((a, b) => r[b] - r[a]); const w = [0, 0, 0, 0]; w[o[0]] = .5; w[o[1]] = .5; return w; });
    C[`best 2 of 4 by ${n}d, but never under 15% each`] = port(S4, k => { const r = S4.map(d => ret(d, k, n)), o = r.map((x, i) => i).sort((a, b) => r[b] - r[a]); const w = [.15, .15, .15, .15]; w[o[0]] += .2; w[o[1]] += .2; return w; });
    C[`momentum sleeve on only when its ${n}d return > T-bills, else low-vol`] = port(S4, k => ret(M, k, n) > ret(bilD, k, n) ? [.35, .35, .15, .15] : [0, .7, .15, .15]);
  }
  for (const [nm, d] of Object.entries(C)) { const s = stats(d, first0, R), pre = stats(d, first0, ['2018-01-01', '2023-12-31']); (RES[nm] ||= {})[sn] = { ...s, pre }; } }
setOff(0);
const rows = Object.entries(RES).map(([nm, v]) => ({ nm, yr: (v.A.cagr + v.B.cagr) / 2, dd: Math.max(v.A.dd, v.B.dd), sh: (v.A.sharpe + v.B.sharpe) / 2, v })).sort((a, b) => b.yr / b.dd - a.yr / a.dd);
for (const r of rows) console.log(`${r.nm.padEnd(72)} yr ${pct(r.yr)} | worst drop ${pct(-r.dd)} | ret/drop ${(r.yr / r.dd).toFixed(2)} | Sharpe ${r.sh.toFixed(2)} | 2018-23 ${pct(r.v.A.pre.cagr)}`);
