
/* Lower drawdown, round 3: diversify against momentum crashes. Every row on two sets of trading days (A, B). */
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const rankN = n => p => { const v = p.map((_, i) => n - i), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / n)); };
for (const [, rows] of snap) { const liq = rows.filter(r => r.rank < 300);
  const pr = key => { const h = liq.filter(r => r.f[key] != null && isFinite(r.f[key])).sort((a, b) => a.f[key] - b.f[key]); h.forEach((r, n) => { (r.q ||= {})[key] = n / Math.max(1, h.length - 1); }); };
  pr('lowVol'); pr('earningsYield');
  for (const r of rows) { const f = r.f, q = r.q || {}, L = r.rank < 300;
    f.VAL = L && f.earningsYield > 0 ? f.earningsYield : null;                             // cheapest profitable (value)
    f.DEFM = L && f.mom12_1 > 0 ? f.lowVol : null;                                          // calm AND rising
    f.QUAL = L && f.earningsYield > 0 && q.lowVol != null ? q.lowVol + q.earningsYield : null; } }
const ETF = s => series(s).daily;
const spyD = ETF('SPY'), iefD = ETF('IEF'), tltD = ETF('TLT'), gldD = ETF('GLD'), bilD = ETF('BIL');
// weekly re-balanced mix (on the strategy's own rebalance days); weights may be a function of history (risk parity)
const mixW = (parts, wf) => { const n = parts.length, cs = parts.map(p => p.d); let w = wf ? wf(0) : parts.map(p => p.w), v = w.slice(); const out = [1];
  for (let k = 1; k < cs[0].length; k++) { v = v.map((x, j) => x * cs[j][k] / cs[j][k - 1]); const t = v.reduce((a, b) => a + b, 0);
    if (REB.has(first0 + k)) { w = wf ? wf(k) : parts.map(p => p.w); v = w.map(x => x * t * (1 - 0.0002)); } out.push(t); } return out; };
const rvol = (d, k, n = 63) => { if (k < n + 1) return 0.2; let s = 0, s2 = 0; for (let j = k - n + 1; j <= k; j++) { const r = Math.log(d[j] / d[j - 1]); s += r; s2 += r * r; } return Math.max(0.03, Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2) * 252)); };
const rp = cs => k => { const iv = cs.map(d => 1 / rvol(d, k)), t = iv.reduce((a, b) => a + b, 0); return iv.map(x => x / t); };
const volT = (d, target, n = 63) => { const o = [1]; let v = 1, e = 1; for (let k = 1; k < d.length; k++) { if (k % 5 === 0) { const ne = Math.min(1, target / rvol(d, k - 1, n)); v *= 1 - Math.abs(ne - e) * 0.0005; e = ne; } v *= 1 + e * (d[k] / d[k - 1] - 1) + (1 - e) * (bilD[k] / bilD[k - 1] - 1); o.push(v); } return o; };
const hedge = (d, h) => { const o = [1]; let v = 1; for (let k = 1; k < d.length; k++) { v *= 1 + (d[k] / d[k - 1] - 1) - h * (spyD[k] / spyD[k - 1] - 1) + h * (bilD[k] / bilD[k - 1] - 1); o.push(v); } return o; };

const RES = {};
for (const [sn, os] of Object.entries({ A: [0, 5, 10, 15], B: [2, 7, 12, 17] })) {
  setMulti(os); const S_ = cfg => simulate(cfg).daily;
  const M = S_(B('IND')), M15 = S_(B('IND', { top: 15, wfun: rankN(15) })), LV = S_(B('LOWV', { wfun: eqW })), LV20 = S_(B('LOWV', { top: 20, wfun: p => p.map(() => 1 / Math.max(20, p.length)) })),
    DM = S_(B('DEFM', { wfun: eqW })), VAL = S_(B('VAL', { wfun: eqW })), QL = S_(B('QUAL', { wfun: eqW }));
  const C = {
    'ref: aggressive (100% momentum)': M,
    'ref: 50 mom / 50 low-vol (monthly mix)': mix([[{ daily: M }, .5], [{ daily: LV }, .5]]).daily,
    '50 mom / 50 low-vol, mixed weekly': mixW([{ d: M, w: .5 }, { d: LV, w: .5 }]),
    'value sleeve alone': VAL,
    'calm-and-rising sleeve alone': DM,
    '50 mom / 50 calm-and-rising': mixW([{ d: M, w: .5 }, { d: DM, w: .5 }]),
    '50 mom / 50 value': mixW([{ d: M, w: .5 }, { d: VAL, w: .5 }]),
    '40 mom / 30 low-vol / 30 value': mixW([{ d: M, w: .4 }, { d: LV, w: .3 }, { d: VAL, w: .3 }]),
    '40 mom / 30 calm-rising / 30 value': mixW([{ d: M, w: .4 }, { d: DM, w: .3 }, { d: VAL, w: .3 }]),
    '40 mom / 40 low-vol / 20 TLT': mixW([{ d: M, w: .4 }, { d: LV, w: .4 }, { d: tltD, w: .2 }]),
    '40 mom / 30 low-vol / 15 IEF / 15 gold': mixW([{ d: M, w: .4 }, { d: LV, w: .3 }, { d: iefD, w: .15 }, { d: gldD, w: .15 }]),
    '35 mom / 25 low-vol / 20 value / 10 IEF / 10 gold': mixW([{ d: M, w: .35 }, { d: LV, w: .25 }, { d: VAL, w: .2 }, { d: iefD, w: .1 }, { d: gldD, w: .1 }]),
    '50 mom(top 15) / 50 low-vol(top 20)': mixW([{ d: M15, w: .5 }, { d: LV20, w: .5 }]),
    'risk parity: mom + low-vol': mixW([{ d: M }, { d: LV }], rp([M, LV])),
    'risk parity: mom + low-vol + value': mixW([{ d: M }, { d: LV }, { d: VAL }], rp([M, LV, VAL])),
    'risk parity: mom + low-vol + IEF + gold': mixW([{ d: M }, { d: LV }, { d: iefD }, { d: gldD }], rp([M, LV, iefD, gldD])),
    'momentum hedged 50% with short SPY': hedge(M, 0.5),
    '50/50 low-vol, momentum hedged 50%': mixW([{ d: hedge(M, 0.5), w: .5 }, { d: LV, w: .5 }]),
  };
  const best = mixW([{ d: M, w: .4 }, { d: LV, w: .3 }, { d: VAL, w: .3 }]);
  C['40/30/30 value mix + swing limit 18%'] = volT(best, 0.18);
  C['40/30/30 value mix + swing limit 15%'] = volT(best, 0.15);
  C['50/50 low-vol + swing limit 18%'] = volT(mixW([{ d: M, w: .5 }, { d: LV, w: .5 }]), 0.18);
  C['risk parity mom+lv+val + swing limit 15%'] = volT(mixW([{ d: M }, { d: LV }, { d: VAL }], rp([M, LV, VAL])), 0.15);
  for (const [nm, d] of Object.entries(C)) { const s = stats(d, first0, R), per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => stats(d, first0, p).cagr); (RES[nm] ||= {})[sn] = { ...s, per }; } }
setOff(0);
const rows = Object.entries(RES).map(([nm, v]) => ({ nm, yr: (v.A.cagr + v.B.cagr) / 2, dd: Math.max(v.A.dd, v.B.dd), sh: (v.A.sharpe + v.B.sharpe) / 2, v })).sort((a, b) => a.dd - b.dd);
console.log('Sorted by worst drop (worse of days A and B). yr = average of A and B. ret/drop = yr / worst drop.\n');
for (const r of rows) console.log(`${r.nm.padEnd(50)} yr ${pct(r.yr)} | worst drop ${pct(-r.dd)} (A ${pct(-r.v.A.dd).trim()}, B ${pct(-r.v.B.dd).trim()}) | ret/drop ${(r.yr / r.dd).toFixed(2)} | Sharpe ${r.sh.toFixed(2)} | A periods ${r.v.A.per.map(x => pct(x).trim()).join(' ')}`);
