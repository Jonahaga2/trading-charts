const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const mixc = parts => mix(parts.map(([d, w]) => [{ daily: d }, w])).daily;
const run = cfg => { setMulti([0, 5, 10, 15]); return simulate(cfg).daily; };
const LV = run(B('LOWV', { wfun: eqW }));
const rep = (nm, d) => { setOff(0); const s = stats(d, first0, R), per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => stats(d, first0, p).cagr); const m = monthly(d);
  console.log(`${nm.padEnd(46)} yr ${pct(s.cagr)} | worstDD ${pct(-s.dd)} | Sharpe ${s.sharpe.toFixed(2)} | month avg ${pct(m.reduce((a, b) => a + b, 0) / m.length)} | 18-21 ${pct(per[0])} 22-23 ${pct(per[1])} 24+ ${pct(per[2])}`); };
// count how often the stop fires
let fires = 0; const X = (o) => ({ type: 'x', keepEntry: true, ...o });
const VS = [['no stop', {}], ['20% below buy price (re-buy next week if still top 10)', X({ stop: 0.2 })], ['20% below buy, then skip it for 4 weeks', X({ stop: 0.2, cool: 4 })], ['20% below buy, then skip it for 13 weeks', X({ stop: 0.2, cool: 13 })],
  ['15% below buy price', X({ stop: 0.15 })], ['25% below buy price', X({ stop: 0.25 })], ['30% below buy price', X({ stop: 0.3 })], ['trailing 20% below the high since buying', X({ trail: 0.2 })], ['(old test) 20% below LAST WEEK\'s price', { type: 'x', stop: 0.2 }]];
console.log('AGGRESSIVE+ (100% momentum + industry filter)');
const M = {}; for (const [nm, ex] of VS) { M[nm] = run(B('IND', { exit: ex })); rep(nm, M[nm]); }
console.log('\n50% MOMENTUM (stop applied) / 50% LOW-VOL (no stop)');
for (const [nm, ex] of VS) rep(nm, mixc([[M[nm], 0.5], [LV, 0.5]]));
console.log('\n50/50 with the 20% stop on BOTH halves');
rep('20% stop on both', mixc([[M['20% below buy price (re-buy next week if still top 10)'], 0.5], [run(B('LOWV', { wfun: eqW, exit: X({ stop: 0.2 }) })), 0.5]]));
// how often does a 20% stop fire, and what happens after
setMulti([0, 5, 10, 15]); const ds = [...REB.keys()].sort((a, b) => a - b).filter(j => days[j] >= '2018'); let held = 0, hit = 0, after = [];
{ const open = new Map(); for (let n = 0; n < ds.length; n++) { const j = ds[n]; const p = new Set(snap.get(REB.get(j)).filter(r => r.rank < 300 && r.f.IND != null && !isNaN(O[r.k][j])).sort((a, b) => b.f.IND - a.f.IND).slice(0, 10).map(r => r.k));
  for (const [k, t] of open) if (!p.has(k)) open.delete(k); for (const k of p) if (!open.has(k)) open.set(k, { j, px: O[k][j], hit: false });
  const j2 = ds[n + 1] ?? N - 1; for (const [k, t] of open) { if (t.hit) continue; for (let i = j; i < j2; i++) if (C[k][i] < t.px * 0.8) { t.hit = true; hit++; const e = Math.min(N - 1, i + 63); after.push(C[k][e] / C[k][i] - 1); break; } } } held = ds.length; }
after = after.filter(isFinite).sort((a, b) => a - b);
console.log(`\n20% stop fired ${hit} times (of ~920 trades). After it fired, the stock's next 3 months: median ${pct(after[after.length >> 1])}, ${Math.round(after.filter(x => x > 0).length / after.length * 100)}% went back up`);
