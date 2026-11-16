
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const X = o => ({ type: 'x', keepEntry: true, ...o });
const ETF = s => series(s).daily;
const iefD = ETF('IEF'), tltD = ETF('TLT'), gldD = ETF('GLD'), bilD = ETF('BIL'), shyD = ETF('SHY');
const mixW = (parts) => { const cs = parts.map(p => p.d); let v = parts.map(p => p.w); const out = [1];
  for (let k = 1; k < cs[0].length; k++) { v = v.map((x, j) => x * cs[j][k] / cs[j][k - 1]); const t = v.reduce((a, b) => a + b, 0); if (REB.has(first0 + k)) v = parts.map(p => p.w * t * (1 - 0.0002)); out.push(t); } return out; };
const rvol = (d, k, n = 63) => { if (k < n + 1) return 0.2; let s = 0, s2 = 0; for (let j = k - n + 1; j <= k; j++) { const r = Math.log(d[j] / d[j - 1]); s += r; s2 += r * r; } return Math.max(0.03, Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2) * 252)); };
const volT = (d, target) => { const o = [1]; let v = 1, e = 1; for (let k = 1; k < d.length; k++) { if (k % 5 === 0) { const ne = Math.min(1, target / rvol(d, k - 1)); v *= 1 - Math.abs(ne - e) * 0.0005; e = ne; } v *= 1 + e * (d[k] / d[k - 1] - 1) + (1 - e) * (bilD[k] / bilD[k - 1] - 1); o.push(v); } return o; };
const RES = {};
for (const [sn, os] of Object.entries({ A: [0, 5, 10, 15], B: [2, 7, 12, 17] })) {
  setMulti(os); const S_ = cfg => simulate(cfg).daily;
  const M = S_(B('IND')), MT = S_(B('IND', { exit: X({ atrTrail: 3 }) })), LV = S_(B('LOWV', { wfun: eqW }));
  const mk = (m, lv, ief, gld, tlt = 0, mom = M) => mixW([{ d: mom, w: m }, { d: LV, w: lv }, { d: iefD, w: ief }, { d: gldD, w: gld }, { d: tltD, w: tlt }].filter(p => p.w > 0));
  const C = {
    '50 mom / 50 low-vol (current best mix)': mk(.5, .5, 0, 0),
    '40 mom / 30 low-vol / 15 IEF / 15 gold': mk(.4, .3, .15, .15),
    '40 mom / 30 low-vol / 30 IEF (no gold)': mk(.4, .3, .3, 0),
    '40 mom / 40 low-vol / 20 IEF (no gold)': mk(.4, .4, .2, 0),
    '40 mom / 30 low-vol / 20 IEF / 10 gold': mk(.4, .3, .2, .1),
    '45 mom / 30 low-vol / 15 IEF / 10 gold': mk(.45, .3, .15, .1),
    '35 mom / 35 low-vol / 15 IEF / 15 gold': mk(.35, .35, .15, .15),
    '35 mom / 30 low-vol / 20 IEF / 15 gold': mk(.35, .3, .2, .15),
    '30 mom / 30 low-vol / 20 IEF / 20 gold': mk(.3, .3, .2, .2),
    '40 mom / 30 low-vol / 10 IEF / 10 TLT / 10 gold': mk(.4, .3, .1, .1, .1),
    '40/30/15/15 with trailing 3x stop on momentum': mk(.4, .3, .15, .15, 0, MT),
    '35/35/15/15 with trailing 3x stop on momentum': mk(.35, .35, .15, .15, 0, MT),
  };
  C['40/30/15/15 + swing limit 15%'] = volT(C['40 mom / 30 low-vol / 15 IEF / 15 gold'], 0.15);
  C['40/30/15/15 + swing limit 13%'] = volT(C['40 mom / 30 low-vol / 15 IEF / 15 gold'], 0.13);
  for (const [nm, d] of Object.entries(C)) { const s = stats(d, first0, R), pre = stats(d, first0, ['2018-01-01', '2023-12-31']), per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => stats(d, first0, p)); (RES[nm] ||= {})[sn] = { ...s, pre, per }; } }
setOff(0);
const g = stats(gldD, first0, ['2018-01-01', '2023-12-31']), g2 = stats(gldD, first0, ['2024-01-01', '2099']);
console.log(`gold: 2018-23 ${pct(g.cagr)}/yr, 2024+ ${pct(g2.cagr)}/yr\n`);
const rows = Object.entries(RES).map(([nm, v]) => ({ nm, yr: (v.A.cagr + v.B.cagr) / 2, dd: Math.max(v.A.dd, v.B.dd), sh: (v.A.sharpe + v.B.sharpe) / 2, v })).sort((a, b) => a.dd - b.dd);
for (const r of rows) console.log(`${r.nm.padEnd(48)} yr ${pct(r.yr)} | worst drop ${pct(-r.dd)} | Sharpe ${r.sh.toFixed(2)} | before gold boom (2018-23): ${pct(r.v.A.pre.cagr)} drop ${pct(-Math.max(r.v.A.pre.dd, r.v.B.pre.dd))} | 18-21 ${pct(r.v.A.per[0].cagr)} 22-23 ${pct(r.v.A.per[1].cagr)} 24+ ${pct(r.v.A.per[2].cagr)}`);
