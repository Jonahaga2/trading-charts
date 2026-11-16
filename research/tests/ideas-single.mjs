
/* Ideas 1, 2, 4, 5, 6, 8 — each alone, against the current bot (100% stocks, weekly, rank weights) and the main plan. */
const rankW = p => { const v = p.map((_, n) => 10 - n), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 10)); };
const eqW = p => p.map(() => 1 / Math.max(10, p.length));
const SIC = JSON.parse(fs.readFileSync(path.join(S, 'sic.json'), 'utf8'));
const ind = k => { const x = SIC[syms[k].replace(/#old\d+$/, '')]; return x && x.sic ? Math.floor(x.sic / 100) : null; };
for (const [, rows] of snap) {
  // industry average 12-1 momentum (all stocks that day), at least 3 members
  const g = new Map(); for (const r of rows) { const h = ind(r.k); if (h == null || r.f.mom12_1 == null) continue; const x = g.get(h) || { s: 0, n: 0, sm: 0 }; x.s += r.f.mom12_1; x.sm += r.f.smoothMom; x.n++; g.set(h, x); }
  const liq = rows.filter(r => r.rank < 300 && r.f.smoothMom != null);
  for (const r of liq) { const x = g.get(ind(r.k)); r.f.indMom = x && x.n >= 3 ? x.s / x.n : null; r.f.indSm = x && x.n >= 3 ? x.sm / x.n : null; }
  const indRank = [...new Set(liq.map(r => r.f.indMom).filter(v => v != null))].sort((a, b) => a - b); const med = indRank[indRank.length >> 1];
  const pr = key => { const h = liq.filter(r => r.f[key] != null && isFinite(r.f[key])).sort((a, b) => a.f[key] - b.f[key]); h.forEach((r, n) => { (r.q ||= {})[key] = n / Math.max(1, h.length - 1); }); };
  for (const key of ['smoothMom', 'residMom', 'indMom', 'lowVol', 'earningsYield']) pr(key);
  for (const r of rows) { const f = r.f, q = r.q || {}, ok = f.smoothMom != null && (f.ret3y == null || f.ret3y < 2);
    f.A = ok ? f.smoothMom : null;
    f.RES = ok ? f.residMom : null;                                                  // 1a market-adjusted momentum
    f.RESIND = ok && f.indSm != null ? f.smoothMom - f.indSm : null;                 // 1b beat its own industry
    f.RESBL = ok && q.residMom != null ? q.smoothMom + q.residMom : null;             // 1c blend raw + market-adjusted
    f.INDB = ok && q.indMom != null ? q.smoothMom + q.indMom : null;                  // 5a stock + industry momentum blend
    f.INDF = ok && f.indMom != null && f.indMom >= med ? f.smoothMom : null;          // 5b only top-half industries
    f.QUAL = r.rank < 300 && f.earningsYield > 0 && q.lowVol != null ? q.lowVol + q.earningsYield : null;   // 4 quality: profitable + calm
    f.LOWV = r.rank < 300 ? f.lowVol : null; } }
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
console.log('Each line: averaged over 4 weekly start days. AGG = 100% stocks, MAIN = 50% stocks / 30% SPY / 20% bonds.\n');
console.log('BASELINE'); go('AGG  current', B('A'), 'weekly', 1); go('MAIN current', B('A'), 'weekly', 0.5);
console.log('\n1) RESIDUAL MOMENTUM'); for (const [k, nm] of [['RES', 'beat the market (beta-adjusted)'], ['RESIND', 'beat its own industry'], ['RESBL', 'blend raw + beat-the-market']]) { go('AGG  ' + nm, B(k), 'weekly', 1); go('MAIN ' + nm, B(k), 'weekly', 0.5); }
console.log('\n5) INDUSTRY + STOCK MOMENTUM'); for (const [k, nm] of [['INDB', 'blend stock + industry momentum'], ['INDF', 'only stocks in top-half industries']]) { go('AGG  ' + nm, B(k), 'weekly', 1); go('MAIN ' + nm, B(k), 'weekly', 0.5); }

// helpers for sleeve mixes and overlays: one curve per weekly start day
const curves = cfg => SCHED.weekly.map(os => { setMulti(os); const d = simulate(cfg).daily; return d; });
const spyD = series('SPY').daily, iefD = series('IEF').daily;
const report = (nm, res) => { setOff(0); const st = res.map(d => stats(d, first0, R)), m = res.flatMap(d => monthly(d)), per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => res.reduce((a, d) => a + stats(d, first0, p).cagr, 0) / res.length);
  console.log(`${nm.padEnd(44)} yr ${pct(st.reduce((a, s) => a + s.cagr, 0) / st.length)} | month avg ${pct(m.reduce((a, b) => a + b, 0) / m.length)} | Sharpe ${(st.reduce((a, s) => a + s.sharpe, 0) / st.length).toFixed(2)} | worstDD ${pct(-Math.max(...st.map(s => s.dd)))} | 18-21 ${pct(per[0])} 22-23 ${pct(per[1])} 24+ ${pct(per[2])}`); };
const momC = curves(B('A')), qualC = curves(B('QUAL', { wfun: eqW })), lowvC = curves(B('LOWV', { wfun: eqW }));
const mixc = (parts) => mix(parts.map(([d, w]) => [{ daily: d }, w])).daily;
console.log('\n4) MOMENTUM + QUALITY SLEEVE (weekly picks, sleeves re-balanced monthly)');
report('quality sleeve alone (profitable + calm)', qualC); report('low-volatility sleeve alone', lowvC);
for (const w of [0.7, 0.5]) report(`${w * 100}% momentum / ${100 - w * 100}% quality`, momC.map((d, n) => mixc([[d, w], [qualC[n], 1 - w]])));
report('50% momentum / 50% low-vol', momC.map((d, n) => mixc([[d, 0.5], [lowvC[n], 0.5]])));
report('50% mom / 25% quality / 25% SPY', momC.map((d, n) => mixc([[d, 0.5], [qualC[n], 0.25], [spyD, 0.25]])));

// 2) crash guard overlays on the aggressive curve
const spyc = E.SPY.c;
const overlay = (nm, decide) => report(nm, momC.map(d => { const o = [1]; let v = 1, e = decide.init ?? 1; for (let k = 1; k < d.length; k++) { const i = first0 + k;
  if (k % 5 === 0) { const ne = decide(i); if (ne !== e) { v *= 1 - Math.abs(ne - e) * 0.0005; e = ne; } }
  const rs = d[k] / d[k - 1] - 1, ra = decide.alt === 'SPY' ? spyc[i] / spyc[i - 1] - 1 : bilC[i] / bilC[i - 1] - 1; v *= 1 + e * rs + (1 - e) * ra; o.push(v); } return o; }));
const ret = (i, n) => spyc[i] / spyc[i - n] - 1, hi = (i, n) => { let m = 0; for (let j = i - n; j <= i; j++) m = Math.max(m, spyc[j]); return m; };
const vol = (i, n) => { let s = 0, s2 = 0; for (let j = i - n + 1; j <= i; j++) { const r = Math.log(spyc[j] / spyc[j - 1]); s += r; s2 += r * r; } return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2) * 252); };
console.log('\n2) MOMENTUM CRASH GUARD (aggressive, checked weekly)');
report('no guard (aggressive)', momC);
{ const f = i => ret(i, 504) < 0 ? 0.5 : 1; overlay('market down over 2 yrs -> half in T-bills', f); }
{ const f = i => ret(i, 504) < 0 ? 0 : 1; f.alt = 'SPY'; overlay('market down over 2 yrs -> hold SPY', f); }
{ const f = i => ret(i, 252) < 0 ? 0 : 1; f.alt = 'SPY'; overlay('market down over 1 yr -> hold SPY', f); }
{ const f = i => spyc[i] < hi(i, 252) * 0.8 ? 0 : 1; f.alt = 'SPY'; overlay('market 20%+ below its high -> hold SPY', f); }
{ const f = i => ret(i, 252) < 0 && vol(i, 63) > 0.25 ? 0 : 1; f.alt = 'SPY'; overlay('down 1 yr AND wild (vol>25%) -> hold SPY', f); }
{ const f = i => vol(i, 21) > 0.35 ? 0.5 : 1; overlay('market swings > 35% -> half in T-bills', f); }

// 6) leverage on the main plan
console.log('\n6) MAIN PLAN WITH MARGIN (borrow cost = T-bill rate + 2%/yr)');
const mainC = momC.map(d => mixc([[d, 0.5], [spyD, 0.3], [iefD, 0.2]]));
report('main plan 1.0x', mainC); report('aggressive 1.0x (for comparison)', momC);
for (const L of [1.25, 1.5, 2]) report(`main plan ${L}x`, mainC.map(d => { const o = [1]; let v = 1; for (let k = 1; k < d.length; k++) { const i = first0 + k, r = d[k] / d[k - 1] - 1, b = bilC[i] / bilC[i - 1] - 1 + 0.02 / 252; v *= 1 + L * r - (L - 1) * b; o.push(Math.max(v, 1e-9)); } return o; }));

// 8) calendar
console.log('\n8) CALENDAR');
{ const f = i => days[i].slice(5, 7) === '01' ? 0 : 1; f.alt = 'SPY'; overlay('hold SPY instead in January', f); }
{ const f = i => ['05', '06', '07', '08', '09', '10'].includes(days[i].slice(5, 7)) ? 0 : 1; f.alt = 'SPY'; overlay('hold SPY May-Oct ("sell in May")', f); }
const byMonth = Array.from({ length: 12 }, () => []); for (const d of momC.slice(0, 1)) { let prev = null, pm = null; for (let k = 0; k < d.length; k++) { const i = first0 + k; if (me.has(i) && days[i] >= '2018') { if (prev != null) { const mo = +days[i].slice(5, 7) - 1; byMonth[mo].push(d[k] / prev - 1 - (spyc[i] / pm - 1)); } prev = d[k]; pm = spyc[i]; } } }
console.log('momentum minus SPY by calendar month (avg): ' + byMonth.map((a, m) => `${'JFMAMJJASOND'[m]} ${pct(a.reduce((x, y) => x + y, 0) / a.length).trim()}`).join('  '));
