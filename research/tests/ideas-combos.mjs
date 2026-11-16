
const rankW = p => { const v = p.map((_, n) => 10 - n), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 10)); };
const eqW = p => p.map(() => 1 / Math.max(10, p.length));
const SIC = JSON.parse(fs.readFileSync(path.join(S, 'sic.json'), 'utf8'));
const SQ = JSON.parse(fs.readFileSync(path.join(S, 'sec-q.json'), 'utf8'));
const base = s => s.replace(/#old\d+$/, '');
const ind = k => { const x = SIC[base(syms[k])]; return x && x.sic ? Math.floor(x.sic / 100) : null; };
// SUE: latest quarter filed by day d: (NI − NI a year earlier) ÷ std of the last 8 such changes (needs 4+)
const sueAt = (sym, day) => { const q = SQ[sym]; if (!q || q.length < 9) return null; let last = -1; for (let n = 0; n < q.length; n++) if (q[n].filed <= day) last = n; if (last < 8) return null;
  const ageDays = (Date.parse(day) - Date.parse(q[last].filed)) / 864e5; const d = []; for (let n = Math.max(4, last - 7); n <= last; n++) { const a = q[n], b = q.find(z => Math.abs((Date.parse(a.end) - Date.parse(z.end)) / 864e5 - 365) < 20); if (b) d.push({ v: a.ni - b.ni, n }); }
  if (d.length < 4 || d.at(-1).n !== last) return null; const mu = d.slice(0, -1).reduce((x, y) => x + y.v, 0) / (d.length - 1), sd = Math.sqrt(d.slice(0, -1).reduce((x, y) => x + (y.v - mu) ** 2, 0) / (d.length - 1)) || 1;
  return { sue: (d.at(-1).v - mu) / sd, age: ageDays }; };
let cover = 0, tot = 0;
for (const [i, rows] of snap) {
  const g = new Map(); for (const r of rows) { const h = ind(r.k); if (h == null || r.f.mom12_1 == null) continue; const x = g.get(h) || { s: 0, n: 0 }; x.s += r.f.mom12_1; x.n++; g.set(h, x); }
  const liq = rows.filter(r => r.rank < 300 && r.f.smoothMom != null);
  for (const r of liq) { const x = g.get(ind(r.k)); r.f.indMom = x && x.n >= 3 ? x.s / x.n : null; const su = sueAt(base(syms[r.k]), days[i]); r.f.sue = su ? su.sue : null; r.f.sueAge = su ? su.age : null; tot++; if (su) cover++; }
  const im = [...new Set(liq.map(r => r.f.indMom).filter(v => v != null))].sort((a, b) => a - b), med = im[im.length >> 1];
  const pr = key => { const h = liq.filter(r => r.f[key] != null && isFinite(r.f[key])).sort((a, b) => a.f[key] - b.f[key]); h.forEach((r, n) => { (r.q ||= {})[key] = n / Math.max(1, h.length - 1); }); };
  for (const key of ['smoothMom', 'sue', 'lowVol', 'earningsYield']) pr(key);
  for (const r of rows) { const f = r.f, q = r.q || {}, ok = f.smoothMom != null && (f.ret3y == null || f.ret3y < 2), indOk = f.indMom == null || f.indMom >= med;
    f.A = ok ? f.smoothMom : null;
    f.SUEF = ok && !(f.sue != null && f.sue < 0 && f.sueAge < 90) ? f.smoothMom : null;           // 3a skip fresh earnings misses
    f.SUEB = ok ? q.smoothMom + (q.sue ?? 0.5) : null;                                                // 3b blend momentum + surprise
    f.SUEP = r.rank < 300 && f.sue != null && f.sueAge < 60 ? f.sue : null;                           // 3c pure earnings drift
    f.IND = ok && indOk ? f.smoothMom : null;                                                        // 5b top-half industries
    f.INDSUE = ok && indOk && !(f.sue != null && f.sue < 0 && f.sueAge < 90) ? f.smoothMom : null;
    f.LOWV = r.rank < 300 ? f.lowVol : null; } }
console.log(`earnings-surprise data covers ${(cover / tot * 100).toFixed(0)}% of top-300 stock-days (delisted companies are missing)\n`);
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
console.log('3) EARNINGS SURPRISE DRIFT');
go('AGG  current', B('A'), 'weekly', 1);
go('AGG  skip fresh earnings misses', B('SUEF'), 'weekly', 1); go('MAIN skip fresh earnings misses', B('SUEF'), 'weekly', 0.5);
go('AGG  blend momentum + surprise', B('SUEB'), 'weekly', 1);
go('pure earnings drift (top 10 surprises)', B('SUEP'), 'weekly', 1);

const curves = cfg => SCHED.weekly.map(os => { setMulti(os); return simulate(cfg).daily; });
const spyD = series('SPY').daily, iefD = series('IEF').daily, spyc = E.SPY.c;
const report = (nm, res) => { setOff(0); const st = res.map(d => stats(d, first0, R)), m = res.flatMap(d => monthly(d)), per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => res.reduce((a, d) => a + stats(d, first0, p).cagr, 0) / res.length);
  console.log(`${nm.padEnd(50)} yr ${pct(st.reduce((a, s) => a + s.cagr, 0) / st.length)} | mo ${pct(m.reduce((a, b) => a + b, 0) / m.length)} | Sharpe ${(st.reduce((a, s) => a + s.sharpe, 0) / st.length).toFixed(2)} | worstDD ${pct(-Math.max(...st.map(s => s.dd)))} | 18-21 ${pct(per[0])} 22-23 ${pct(per[1])} 24+ ${pct(per[2])}`); return st; };
const mixc = parts => mix(parts.map(([d, w]) => [{ daily: d }, w])).daily;
const decSPY = d => { const o = [1]; let v = 1; for (let k = 1; k < d.length; k++) { const i = first0 + k; const r = days[i].slice(5, 7) === '12' ? spyc[i] / spyc[i - 1] - 1 : d[k] / d[k - 1] - 1; v *= 1 + r; o.push(v); } return o; };

console.log('\nCOMBINATIONS');
const cA = curves(B('A')), cI = curves(B('IND')), cIS = curves(B('INDSUE')), cL = curves(B('LOWV', { wfun: eqW }));
report('AGG  current', cA);
report('AGG  + top-half industries', cI);
report('AGG  + top-half industries + skip misses', cIS);
report('AGG  + top-half industries + SPY in December', cI.map(decSPY));
report('70% (mom + industries) / 30% low-vol', cI.map((d, n) => mixc([[d, 0.7], [cL[n], 0.3]])));
report('MAIN current (50 mom / 30 SPY / 20 bonds)', cA.map(d => mixc([[d, 0.5], [spyD, 0.3], [iefD, 0.2]])));
report('MAIN + top-half industries', cI.map(d => mixc([[d, 0.5], [spyD, 0.3], [iefD, 0.2]])));
report('50% (mom + industries) / 50% low-vol', cI.map((d, n) => mixc([[d, 0.5], [cL[n], 0.5]])));
report('50% (mom + ind) / 30% low-vol / 20% bonds', cI.map((d, n) => mixc([[d, 0.5], [cL[n], 0.3], [iefD, 0.2]])));
report('60% (mom + ind) / 40% low-vol', cI.map((d, n) => mixc([[d, 0.6], [cL[n], 0.4]])));

// Trade at the close (market-on-close): shift the "open" to the prior close for the best ones
console.log('\nSAME, TRADING AT THE CLOSE (market-on-close orders)');
const O0 = O.slice(); for (let k = 0; k < NS; k++) { const a = new Float32Array(N).fill(NaN); for (let i = 1; i < N; i++) a[i] = C[k][i - 1]; O[k] = a; }
const mI = curves(B('IND')), mL = curves(B('LOWV', { wfun: eqW }));
report('AGG  + top-half industries, at close', mI);
report('60% (mom + ind) / 40% low-vol, at close', mI.map((d, n) => mixc([[d, 0.6], [mL[n], 0.4]])));
for (let k = 0; k < NS; k++) O[k] = O0[k];

// Luck check for the industry filter: random half of industries instead of the top half (20 tries)
console.log('\nLUCK CHECK: keep a RANDOM half of industries instead of the top half');
const res = []; for (let t = 0; t < 20; t++) { let sd = 99 + t; const rng = () => (sd = (sd * 16807) % 2147483647) / 2147483647; const keep = new Map();
  for (const [, rows] of snap) for (const r of rows) { const h = ind(r.k); if (!keep.has(h)) keep.set(h, rng() < 0.5); r.f.RNDI = r.f.A != null && (h == null || keep.get(h)) ? r.f.A : null; }
  setMulti([0, 5, 10, 15]); res.push(stats(simulate(B('RNDI')).daily, first0, R).cagr); }
res.sort((a, b) => a - b); console.log(`random-industry filter, aggressive: median ${pct(res[10])}, best ${pct(res[19])}  (top-half industries got about +55%)`);
