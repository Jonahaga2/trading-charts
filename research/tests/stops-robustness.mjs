const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const mixc = parts => mix(parts.map(([d, w]) => [{ daily: d }, w])).daily;
const X = o => ({ type: 'x', keepEntry: true, ...o });
for (const [, rows] of snap) for (const r of rows) { const f = r.f; for (const t of [0.6, 0.8, 1.0, 1.2, 1.5]) f['V' + t] = f.IND != null && -f.lowVol < t ? f.IND : null; }
const SETS = { A: [0, 5, 10, 15], B: [2, 7, 12, 17] };
const res = {};
for (const [sn, os] of Object.entries(SETS)) { const run = cfg => { setMulti(os); return simulate(cfg).daily; }; const LV = run(B('LOWV', { wfun: eqW }));
  const put = (nm, d) => { const a = stats(d, first0, R), m = stats(mixc([[d, 0.5], [LV, 0.5]]), first0, R); (res[nm] ||= {})[sn] = { a, m }; };
  put('no stop', run(B('IND')));
  for (const t of [0.6, 0.8, 1.0, 1.2, 1.5]) put(`skip stocks swinging > ${t * 100}%/yr`, run(B('V' + t)));
  for (const m of [2, 3, 4]) put(`trailing ${m}x daily range`, run(B('IND', { exit: X({ atrTrail: m }) })));
  put('skip >100% swing + trailing 3x', run(B('V1', { exit: X({ atrTrail: 3 }) })));
  put('skip >100% swing + trailing 4x', run(B('V1', { exit: X({ atrTrail: 4 }) }))); }
setOff(0);
const f = s => `${pct(s.cagr)} DD ${pct(-s.dd)} Sh ${s.sharpe.toFixed(2)}`;
console.log(''.padEnd(34), 'AGGRESSIVE days A'.padEnd(30), 'AGGRESSIVE days B'.padEnd(30), '50/50 days A'.padEnd(30), '50/50 days B');
for (const [nm, v] of Object.entries(res)) console.log(nm.padEnd(34), f(v.A.a).padEnd(30), f(v.B.a).padEnd(30), f(v.A.m).padEnd(30), f(v.B.m));
// which stocks does the 100% swing rule remove, and how did they do?
let rm = 0, tt = 0; const names = new Map(); setMulti([0, 5, 10, 15]);
for (const [j, sd] of REB) { if (days[j] < '2018') continue; const top = snap.get(sd).filter(r => r.rank < 300 && r.f.IND != null).sort((a, b) => b.f.IND - a.f.IND).slice(0, 10); for (const r of top) { tt++; if (!(-r.f.lowVol < 1)) { rm++; names.set(syms[r.k], (names.get(syms[r.k]) || 0) + 1); } } }
setOff(0); console.log(`\nthe >100% swing rule removes ${rm} of ${tt} weekly picks (${(rm / tt * 100).toFixed(0)}%); most often: ` + [...names].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([s, n]) => `${s}(${n})`).join(' '));
