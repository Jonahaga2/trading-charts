/* Walk-forward model: predict each liquid stock's next-month return from its traits (ranked 0-1 each day).
   Refit every month on past months only (target fully known before the day it is used). */
const FX = ['smoothMom', 'reversal1m', 'lowVol', 'near52wHigh', 'antiLottery', 'trend200', 'volSurge', 'gain1y', 'closeLocation'];
const rankFeats = rows => { const out = new Map(rows.map(r => [r.k, []])); for (const f of FX) { const have = rows.filter(r => r.f[f] != null && isFinite(r.f[f])).sort((a, b) => a.f[f] - b.f[f]); const m = new Map(have.map((r, n) => [r.k, n / Math.max(1, have.length - 1)])); for (const r of rows) out.get(r.k).push(m.has(r.k) ? m.get(r.k) : 0.5); } return out; };
const TR = [];   // {known: day index when target known, x, y}
for (let n = 0; n < monthEnds.length - 1; n++) { const i = monthEnds[n], j = monthEnds[n + 1]; if (j + 1 >= N) break;
  const rows = snap.get(i).filter(r => r.rank < 300 && !isNaN(O[r.k][i + 1])); const X = rankFeats(rows);
  for (const r of rows) { let e = O[r.k][j + 1]; if (isNaN(e)) { let q = j; while (q > i && isNaN(C[r.k][q])) q--; e = C[r.k][q]; } const y = Math.max(-0.9, Math.min(1, e / O[r.k][i + 1] - 1)); TR.push({ known: j + 1, x: X.get(r.k), y }); } }
const ridge = (data, lam = 5) => { const p = FX.length + 1, A = Array.from({ length: p }, () => Array(p).fill(0)), b = Array(p).fill(0);
  for (const d of data) { const x = [1, ...d.x]; for (let a = 0; a < p; a++) { b[a] += x[a] * d.y; for (let c = 0; c < p; c++) A[a][c] += x[a] * x[c]; } }
  for (let a = 1; a < p; a++) A[a][a] += lam * data.length / 100;
  for (let c = 0; c < p; c++) { let m = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r; [A[c], A[m]] = [A[m], A[c]]; [b[c], b[m]] = [b[m], b[c]];
    for (let r = 0; r < p; r++) if (r !== c) { const t = A[r][c] / A[c][c]; for (let q = c; q < p; q++) A[r][q] -= t * A[c][q]; b[r] -= t * b[c]; } }
  return b.map((v, a) => v / A[a][a]); };
let coefLog = null;
for (const d of [...snap.keys()].sort((a, b) => a - b)) { const train = TR.filter(t => t.known <= d); const rows = snap.get(d).filter(r => r.rank < 300);
  if (train.length < 300 * 12) { for (const r of rows) r.f.pred = null; continue; }
  const w = ridge(train); coefLog = w; const X = rankFeats(rows); for (const r of rows) r.f.pred = w[0] + X.get(r.k).reduce((a, x, n) => a + x * w[n + 1], 0); }
console.log('latest model weights (which traits it thinks help):', FX.map((f, n) => `${f} ${(coefLog[n + 1] * 100).toFixed(1)}`).join(', '));
for (const [, rows] of snap) for (const r of rows) r.f.predR = r.f.pred != null && (r.f.ret3y == null || r.f.ret3y < 2) ? r.f.pred : null;
const eq = p => p.map(() => 1 / Math.max(10, p.length));
const norm = (p, v) => { const t = v.reduce((a, b) => a + b, 0); return t > 0 ? v.map(x => x / t * Math.min(1, p.length / 10)) : eq(p); };
const capW = (w, cap = 0.25) => { for (let it = 0; it < 10; it++) { const over = w.reduce((a, x) => a + Math.max(0, x - cap), 0); if (over < 1e-9) break; const under = w.filter(x => x < cap).reduce((a, b) => a + b, 0); w = w.map(x => x >= cap ? cap : x + over * x / under); } return w; };
const W = {
  'equal weight (current, weekly)': null,
  'by rank (10,9,...,1)': p => norm(p, p.map((_, n) => 10 - n)),
  'mild rank tilt (15%..5%)': p => norm(p, p.map((_, n) => 1.5 - n / 9)),
  'by momentum score': p => norm(p, p.map(r => Math.max(0, r.f.smoothMomR))),
  'by momentum score squared': p => norm(p, p.map(r => Math.max(0, r.f.smoothMomR) ** 2)),
  'by score squared, max 25% each': p => capW(norm(p, p.map(r => Math.max(0, r.f.smoothMomR) ** 2))),
  'model: momentum top10 weighted by forecast': p => { const v = p.map(r => r.f.pred); if (v.some(x => x == null)) return eq(p); const lo = Math.min(...v); return norm(p, v.map(x => x - lo + 0.01)); },
  'top 1 gets 50%, rest split': p => p.map((_, n) => (n === 0 ? 0.5 : 0.5 / 9) * Math.min(1, p.length / 10)),
};
console.log('\nMomentum half weighted different ways (50/30/20, weekly):');
for (const [nm, wf] of Object.entries(W)) go(nm, T({ wfun: wf }), 'weekly', 0.5);
console.log('\nSame, momentum stocks alone (100%):');
for (const [nm, wf] of Object.entries(W)) go(nm, T({ wfun: wf }), 'weekly', 1);
console.log('\nModel picks the stocks itself (instead of momentum):');
go('model top 10, equal weight (50/30/20)', T({ feat: 'predR' }), 'weekly', 0.5);
go('model top 10, weighted by forecast (50/30/20)', T({ feat: 'predR', wfun: W['model: momentum top10 weighted by forecast'] }), 'weekly', 0.5);
go('model top 10, equal weight (100%)', T({ feat: 'predR' }), 'weekly', 1);
