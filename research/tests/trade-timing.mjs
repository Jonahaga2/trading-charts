const rankW = p => { const v = p.map((_, n) => 10 - n), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 10)); };
for (const [, rows] of snap) for (const r of rows) r.f.A = r.f.smoothMom != null && (r.f.ret3y == null || r.f.ret3y < 2) ? r.f.smoothMom : null;
const B = { feat: 'A', bucket: 'large', top: 10, wfun: rankW };
const O0 = O.slice();
const runAll = lbl => { console.log(lbl); go('  aggressive (100%)', B, 'weekly', 1); go('  main plan (50/30/20)', B, 'weekly', 0.5); };
runAll('TRADE AT NEXT MORNING OPEN (what we tested so far):');
for (let k = 0; k < NS; k++) { const a = new Float32Array(N).fill(NaN); for (let i = 1; i < N; i++) a[i] = C[k][i - 1]; O[k] = a; }
runAll('\nTRADE AT THE CLOSE ON SIGNAL DAY (market-on-close order, signal from prices ~10 min before close):');
for (let k = 0; k < NS; k++) O[k] = C[k];
runAll('\nTRADE AT THE NEXT DAY CLOSE (signal a full day old, no shortcut):');
for (let k = 0; k < NS; k++) O[k] = O0[k];
