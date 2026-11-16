
/* Smaller drawdowns: diagnose the worst drops, then test ways to cut them. */
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const curves = cfg => SCHED.weekly.map(os => { setMulti(os); return simulate(cfg).daily; });
const spyD = series('SPY').daily, iefD = series('IEF').daily, gldD = series('GLD').daily;
const mixc = parts => mix(parts.map(([d, w]) => [{ daily: d }, w])).daily;
const ROWS = [];
const report = (nm, res) => { setOff(0); const st = res.map(d => stats(d, first0, R)), per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => res.reduce((a, d) => a + stats(d, first0, p).cagr, 0) / res.length);
  const yr = st.reduce((a, s) => a + s.cagr, 0) / st.length, dd = Math.max(...st.map(s => s.dd)), sh = st.reduce((a, s) => a + s.sharpe, 0) / st.length;
  ROWS.push({ nm, yr, dd, sh, per }); };
const worstDrops = (nm, d) => { // top 3 separate drawdowns of one curve
  const out = []; let pk = d[0], pkI = 0, cur = null;
  for (let k = 1; k < d.length; k++) { if (d[k] >= pk) { if (cur && cur.dd > 0.1) out.push(cur); cur = null; pk = d[k]; pkI = k; } else { const dd = 1 - d[k] / pk; if (!cur || dd > cur.dd) cur = { dd, from: days[first0 + pkI], low: days[first0 + k] }; } }
  if (cur && cur.dd > 0.1) out.push(cur); out.sort((a, b) => b.dd - a.dd);
  console.log(`${nm}: ` + out.slice(0, 4).map(x => `${pct(-x.dd).trim()} (${x.from} → ${x.low})`).join(' | ')); };

const cI = curves(B('IND')), cL = curves(B('LOWV', { wfun: eqW }));
console.log('WHERE THE BIG DROPS HAPPENED (start day 0):');
worstDrops('aggressive+ (mom + industries)', cI[0]);
worstDrops('balanced (60 mom / 40 low-vol)', mixc([[cI[0], 0.6], [cL[0], 0.4]]));
worstDrops('SPY', spyD);

// --- building blocks
const cI20 = curves(B('IND', { top: 20, wfun: p => { const v = p.map((_, n) => 20 - n), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 20)); } }));
for (const [, rows] of snap) { const liq = rows.filter(r => r.f.IND != null && r.rank < 300).sort((a, b) => b.f.IND - a.f.IND); const cnt = new Map(); for (const r of rows) r.f.CAP2 = null;
  for (const r of liq) { const h = ind(r.k) ?? -r.k, n = cnt.get(h) || 0; if (n < 2) { r.f.CAP2 = r.f.IND; cnt.set(h, n + 1); } } }
const cCap = curves(B('CAP2'));
const hyb = p => { const v = p.map((r, n) => (10 - n) / Math.max(0.15, r.f.vol3m || 0.3)), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 10)); };
const cHyb = curves(B('IND', { wfun: hyb }));

// --- volatility targeting overlay (weekly), using the curve's own past returns
const volT = (res, target, look, alt = 'bil') => res.map(d => { const o = [1]; let v = 1, e = 1; const rets = [];
  for (let k = 1; k < d.length; k++) { const i = first0 + k; if (k % 5 === 0 && rets.length >= look) { const r = rets.slice(-look), mu = r.reduce((a, b) => a + b, 0) / look, sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / look) * Math.sqrt(252); const ne = Math.min(1, target / sd); v *= 1 - Math.abs(ne - e) * 0.0005; e = ne; }
    const rs = d[k] / d[k - 1] - 1, ra = alt === 'ief' ? iefD[k] / iefD[k - 1] - 1 : bilC[i] / bilC[i - 1] - 1; v *= 1 + e * rs + (1 - e) * ra; rets.push(rs); o.push(v); } return o; });

report('A1 aggressive+ (mom + industries)', cI);
report('A2 top 20 instead of 10', cI20);
report('A3 max 2 stocks per industry', cCap);
report('A4 rank weight ÷ stock volatility', cHyb);
for (const w of [0.7, 0.6, 0.5, 0.4]) report(`B  ${w * 100}% mom+ind / ${100 - w * 100}% low-vol`, cI.map((d, n) => mixc([[d, w], [cL[n], 1 - w]])));
report('B  50 mom / 30 low-vol / 20 bonds', cI.map((d, n) => mixc([[d, 0.5], [cL[n], 0.3], [iefD, 0.2]])));
report('B  50 mom / 30 low-vol / 10 bonds / 10 gold', cI.map((d, n) => mixc([[d, 0.5], [cL[n], 0.3], [iefD, 0.1], [gldD, 0.1]])));
report('B  50 mom(cap2) / 50 low-vol', cCap.map((d, n) => mixc([[d, 0.5], [cL[n], 0.5]])));
report('B  50 mom(÷vol) / 50 low-vol', cHyb.map((d, n) => mixc([[d, 0.5], [cL[n], 0.5]])));
for (const [t, lk] of [[0.4, 63], [0.3, 63], [0.3, 126], [0.25, 63]]) report(`C  aggressive+, vol target ${t * 100}% (${lk}d)`, volT(cI, t, lk));
for (const [t, lk] of [[0.25, 63], [0.2, 63], [0.2, 126], [0.15, 63]]) report(`C  60/40 low-vol, vol target ${t * 100}% (${lk}d)`, volT(cI.map((d, n) => mixc([[d, 0.6], [cL[n], 0.4]])), t, lk));
report('C  60/40 low-vol, vol target 20%, spare in bonds', volT(cI.map((d, n) => mixc([[d, 0.6], [cL[n], 0.4]])), 0.2, 63, 'ief'));
report('D  70% momentum (÷vol) / 30% low-vol, vol tgt 25%', volT(cHyb.map((d, n) => mixc([[d, 0.7], [cL[n], 0.3]])), 0.25, 63));
report('ref SPY', [spyD]); report('ref main plan now (50/30/20)', curves(B('A')).map(d => mixc([[d, 0.5], [spyD, 0.3], [iefD, 0.2]])));

console.log('\nALL, sorted by worst drop (smaller first). ret/drop = return per unit of worst drop.');
ROWS.sort((a, b) => a.dd - b.dd);
for (const r of ROWS) console.log(`${r.nm.padEnd(50)} yr ${pct(r.yr)} | worstDD ${pct(-r.dd)} | ret/drop ${(r.yr / r.dd).toFixed(2)} | Sharpe ${r.sh.toFixed(2)} | 18-21 ${pct(r.per[0])} 22-23 ${pct(r.per[1])} 24+ ${pct(r.per[2])}`);
