const rankW = p => { const v = p.map((_, n) => 10 - n), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 10)); };
const B = (exit = {}) => ({ feat: 'smoothMomR', bucket: 'large', top: 10, wfun: rankW, exit: Object.keys(exit).length ? { type: 'x', ...exit } : {} });
const runs = SCHED.weekly.map(os => { setMulti(os); return simulate(B()).daily; }); setOff(0);
const bil = E.BIL.c, iefc = E.IEF.c;
const overlay = (nm, decide) => { const res = runs.map(d => { const o = [1]; let expo = 1, peak = 1, v = 1, rets = []; for (let k = 1; k < d.length; k++) { const i = first0 + k; const rs = d[k] / d[k - 1] - 1, rb = bil[i] / bil[i - 1] - 1, rf = iefc[i] / iefc[i - 1] - 1;
      const ne = decide({ v, peak, rets, k, expo }); if (ne === 1 && expo === 0) peak = v; if (ne !== expo) { v *= 1 - Math.abs(ne - expo) * 0.0005; expo = ne; }
      v *= 1 + expo * rs + (1 - expo) * (decide.safe === 'IEF' ? rf : rb); rets.push(rs); peak = Math.max(peak, v); o.push(v); } return o; });
  const st = res.map(d => stats(d, first0, R)), per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => res.reduce((a, d) => a + stats(d, first0, p).cagr, 0) / res.length);
  const m = res.flatMap(d => monthly(d));
  console.log(`${nm.padEnd(44)} yr ${pct(st.reduce((a, s) => a + s.cagr, 0) / st.length)} | month avg ${pct(m.reduce((a, b) => a + b, 0) / m.length)} | worstDD ${pct(-Math.max(...st.map(s => s.dd)))} | 18-21 ${pct(per[0])} 22-23 ${pct(per[1])} 24+ ${pct(per[2])}`); };
overlay('no brake (check: should be +51.3%)', () => 1);
for (const [dd, wk] of [[0.1, 2], [0.15, 4], [0.2, 4], [0.25, 8]]) { let until = -1, pk = 1, inStocks = true; const f = ({ v, k }) => { if (!inStocks) { if (k < until) return 0; inStocks = true; pk = v; return 1; } pk = Math.max(pk, v); if (v < pk * (1 - dd)) { inStocks = false; until = k + wk * 5; return 0; } return 1; }; overlay(`account down ${dd * 100}% from its high -> T-bills ${wk} wks`, f); }
for (const tv of []) { const f = ({ rets, k, expo }) => { if (k % 5 || rets.length < 20) return expo; const r = rets.slice(-20), mu = r.reduce((a, b) => a + b, 0) / 20, sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / 20) * Math.sqrt(252); return Math.min(1, tv / sd); }; overlay(`cut back when swings > ${tv * 100}%/yr (vol target)`, f); }

