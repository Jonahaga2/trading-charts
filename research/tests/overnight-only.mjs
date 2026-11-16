
/* Overnight-only holding: own the momentum picks from the close to the next open, cash during the day. */
const ED = s => series(s).daily;
const gldD = ED('GLD'), iefD = ED('IEF'), bilD = ED('BIL');
const mixW = parts => { const cs = parts.map(p => p.d); let v = parts.map(p => p.w); const out = [1];
  for (let k = 1; k < cs[0].length; k++) { v = v.map((x, j) => x * cs[j][k] / cs[j][k - 1]); const t = v.reduce((a, b) => a + b, 0); if (REB.has(first0 + k)) v = parts.map(p => p.w * t * (1 - 0.0002)); out.push(t); } return out; };
const lever = (d, L) => { const o = [1]; let v = 1; for (let k = 1; k < d.length; k++) { const r = d[k] / d[k - 1] - 1, b = bilD[k] / bilD[k - 1] - 1 + 0.02 / 252; v *= 1 + L * r - (L - 1) * b; o.push(Math.max(v, 1e-9)); } return o; };
// Build daily curves for: full holding (close-to-close), overnight-only, daytime-only. Picks chosen on each rebalance day j from signal REB.get(j);
// they are held from the CLOSE of day j (no shortcut: signal is a day old). cost = per trade, each side.
const curvesFor = (feat, cost) => { const pk = new Map(); let cur = []; const out = { full: [1], night: [1], day: [1] }; let vf = 1, vn = 1, vd = 1;
  for (let k = 1; k < N - first0; k++) { const i = first0 + k;
    // returns for day i using holdings set at the close of a previous day
    let rf = 0, rn = 0, rd = 0, wsum = 0;
    for (const { k: s, w } of cur) { const c0 = C[s][i - 1], o1 = O[s][i], c1 = C[s][i]; if (!(c0 > 0) || !(o1 > 0) || !(c1 > 0)) continue; rf += w * (c1 / c0 - 1); rn += w * (o1 / c0 - 1); rd += w * (c1 / o1 - 1); wsum += w; }
    const b = bilD[k] / bilD[k - 1] - 1; rf += (1 - wsum) * b; rn += (1 - wsum) * b; rd += (1 - wsum) * b;
    vf *= 1 + rf; vn *= 1 + rn - 2 * cost * wsum; vd *= 1 + rd - 2 * cost * wsum; out.full.push(vf); out.night.push(vn); out.day.push(vd);
    if (REB.has(i)) { const p = snap.get(REB.get(i)).filter(r => r.rank < 300 && r.f[feat] != null && !isNaN(C[r.k][i])).sort((a, b) => b.f[feat] - a.f[feat]).slice(0, 10); const ws = rankW(p);
      const nw = p.map((r, n) => ({ k: r.k, w: ws[n] })); let turn = 0; const m = new Map(cur.map(x => [x.k, x.w])); for (const x of nw) turn += Math.abs(x.w - (m.get(x.k) || 0)); for (const x of cur) if (!nw.some(y => y.k === x.k)) turn += x.w; vf *= 1 - turn * 0.0005; cur = nw; } }
  return out; };
const RES = {};
for (const [sn, os] of Object.entries({ A: [0, 5, 10, 15], B: [2, 7, 12, 17] })) {
  setMulti(os); const LV = simulate({ feat: 'LOWV', bucket: 'large', top: 10, wfun: eqW }).daily;
  for (const cost of [0, 0.0002, 0.0005]) { const c = curvesFor('IND', cost);
    const put = (nm, d) => { const s = stats(d, first0, R), pre = stats(d, first0, ['2018-01-01', '2023-12-31']); (RES[nm] ||= {})[sn] = { ...s, pre, d }; };
    if (cost === 0) { put('momentum held all the time (bought at close)', c.full); put('momentum DAYTIME only (open->close), no cost', c.day); }
    put(`momentum OVERNIGHT only, cost ${(cost * 100).toFixed(2)}%/trade`, c.night);
    put(`35 night-mom / 35 low-vol / 15 IEF / 15 gold, cost ${(cost * 100).toFixed(2)}%`, mixW([{ d: c.night, w: .35 }, { d: LV, w: .35 }, { d: iefD, w: .15 }, { d: gldD, w: .15 }]));
    put(`50 night-mom / 50 low-vol, cost ${(cost * 100).toFixed(2)}%`, mixW([{ d: c.night, w: .5 }, { d: LV, w: .5 }])); } }
setOff(0);
const rows = Object.entries(RES).map(([nm, v]) => ({ nm, yr: (v.A.cagr + v.B.cagr) / 2, dd: Math.max(v.A.dd, v.B.dd), sh: (v.A.sharpe + v.B.sharpe) / 2, v }));
for (const r of rows) console.log(`${r.nm.padEnd(60)} yr ${pct(r.yr)} | worst drop ${pct(-r.dd)} | ret/drop ${(r.yr / r.dd).toFixed(2)} | Sharpe ${r.sh.toFixed(2)} | 2018-23 ${pct(r.v.A.pre.cagr)} drop ${pct(-r.v.A.pre.dd)}`);
console.log('\nLEVERAGED to about a -20% worst drop:');
for (const r of rows.filter(x => /cost 0\.0[25]/.test(x.nm))) { let best = null; for (let L = 1; L <= 4.001; L += 0.05) { const a = stats(lever(r.v.A.d, L), first0, R), b = stats(lever(r.v.B.d, L), first0, R); if (Math.max(a.dd, b.dd) <= 0.205) best = { L, yr: (a.cagr + b.cagr) / 2, dd: Math.max(a.dd, b.dd) }; }
  console.log(`${r.nm.padEnd(60)} ${best ? `${best.L.toFixed(2)}x -> yr ${pct(best.yr)} | worst drop ${pct(-best.dd)}` : 'deeper than -20% even at 1x'}`); }
