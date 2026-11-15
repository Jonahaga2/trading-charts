for (const [, rows] of snap) for (const r of rows) r.f.A = r.f.smoothMom != null && (r.f.ret3y == null || r.f.ret3y < 2) ? r.f.smoothMom : null;
const { pickMomentum, targetWeights } = await import(new URL('../../scanner/paper.mjs', import.meta.url).href);
let same = 0, order = 0, tot = 0, n = 0; const sd = [...snap.keys()].sort((a, b) => a - b).slice(-60);
for (const i of sd) {
  const bt = snap.get(i).filter(r => r.rank < 300 && r.f.A != null).sort((a, b) => b.f.A - a.f.A).slice(0, 10).map(r => syms[r.k]);
  const m = new Map();
  for (let k = 0; k < NS; k++) { if (!rawC[k] || !(rawC[k][i] >= 3)) continue; if (isNaN(C[k][i]) || isNaN(C[k][i - 252]) || isNaN(C[k][i - 21])) continue; const c = [], v = []; for (let j = i - 800; j <= i; j++) if (!isNaN(C[k][j])) { c.push(C[k][j]); v.push(V[k][j]); } m.set(syms[k], { c, v }); }
  const live = pickMomentum(m).map(p => p.sym); n++;
  same += live.filter(s => bt.includes(s)).length; order += live.filter((s, q) => bt[q] === s).length; tot += 10;
  if (i === sd.at(-1)) { const w = targetWeights(pickMomentum(m)); console.log(days[i], '\n backtest:', bt.join(' '), '\n live bot:', live.join(' '), '\n weights :', live.map(s => s + ' ' + (w[s] * 100).toFixed(1) + '%').join(', ')); }
}
console.log(`last ${n} weekly signal days: same stocks ${same}/${tot}, same rank order ${order}/${tot}`);
