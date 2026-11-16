
const B = (feat, o = {}) => ({ feat, bucket: 'large', top: 10, wfun: rankW, ...o });
const mixc = parts => mix(parts.map(([d, w]) => [{ daily: d }, w])).daily;
const run = cfg => { setMulti([0, 5, 10, 15]); const d = simulate(cfg).daily; setOff(0); return d; };
const LV = run(B('LOWV', { wfun: eqW }));
const ROWS = [];
const rep = (nm, d) => { const one = (x, tag) => { const s = stats(x, first0, R), per = [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => stats(x, first0, p).cagr); return { tag, yr: s.cagr, dd: s.dd, sh: s.sharpe, per }; };
  ROWS.push({ nm, a: one(d, 'agg'), m: one(mixc([[d, 0.5], [LV, 0.5]]), '50/50') }); };
const X = o => ({ type: 'x', keepEntry: true, ...o });
// bubble entry filters
for (const [, rows] of snap) for (const r of rows) { const f = r.f; f.NB3 = f.IND != null && f.mom12_1 < 3 ? f.IND : null; f.NB5 = f.IND != null && f.mom12_1 < 5 ? f.IND : null; f.NBV = f.IND != null && -f.lowVol < 1.0 ? f.IND : null; }
rep('NO STOP (aggressive+ / 50-50)', run(B('IND')));
rep('hold until it falls out of the top 15', run(B('IND', { exit: { hold: 15 } })));
rep('hold until it falls out of the top 20', run(B('IND', { exit: { hold: 20 } })));
rep('trailing 2x daily range from the high', run(B('IND', { exit: X({ atrTrail: 2 }) })));
rep('trailing 4x daily range from the high', run(B('IND', { exit: X({ atrTrail: 4 }) })));
rep('trailing 6x daily range from the high', run(B('IND', { exit: X({ atrTrail: 6 }) })));
rep('sell after a 10%+ gap down at the open', run(B('IND', { exit: X({ gap: 0.10 }) })));
rep('sell after a 15%+ gap down at the open', run(B('IND', { exit: X({ gap: 0.15 }) })));
rep('time stop: still below buy price after 4 wks', run(B('IND', { exit: X({ timeW: 4 }) })));
rep('time stop: not up 5% after 8 wks', run(B('IND', { exit: X({ timeW: 8, timeMin: 0.05 }) })));
rep('below 50-day avg AND below buy price', run(B('IND', { exit: X({ maLoss: 50 }) })));
rep('below 20-day avg AND below buy price', run(B('IND', { exit: X({ maLoss: 20 }) })));
rep('20% stop + hold-until-top-15', run(B('IND', { exit: X({ stop: 0.2, hold: 15 }) })));
rep('skip bubbles: up more than 300% in a year', run(B('NB3')));
rep('skip bubbles: up more than 500% in a year', run(B('NB5')));
rep('skip stocks swinging more than 100%/yr', run(B('NBV')));
rep('skip >500% bubbles + trailing 6x range', run(B('NB5', { exit: X({ atrTrail: 6 }) })));
// equity-curve rule: hold the strategy only while its own curve is above its N-day average, else T-bills (checked weekly)
const baseC = run(B('IND')), bc = E.BIL.c;
const eqc = (d, n) => { const o = [1]; let v = 1, e = 1; for (let k = 1; k < d.length; k++) { const i = first0 + k; if (k % 5 === 0 && k > n) { let s = 0; for (let j = k - n; j < k; j++) s += d[j]; const ne = d[k - 1] > s / n ? 1 : 0; if (ne !== e) { v *= 1 - 0.0005; e = ne; } } v *= 1 + e * (d[k] / d[k - 1] - 1) + (1 - e) * (bc[i] / bc[i - 1] - 1); o.push(v); } return o; };
for (const n of [50, 100, 200]) { const d = eqc(baseC, n); ROWS.push({ nm: `account rule: out when strategy < its ${n}-day avg`, a: (() => { const s = stats(d, first0, R); return { yr: s.cagr, dd: s.dd, sh: s.sharpe, per: [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => stats(d, first0, p).cagr) }; })(),
  m: (() => { const x = eqc(mixc([[baseC, 0.5], [LV, 0.5]]), n), s = stats(x, first0, R); return { yr: s.cagr, dd: s.dd, sh: s.sharpe, per: [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099']].map(p => stats(x, first0, p).cagr) }; })() }); }
const f = x => `${pct(x.yr)} DD ${pct(-x.dd)} Sh ${x.sh.toFixed(2)}`;
console.log('Stops measured from the real buy price. Weekly, rank weights, industry filter. 2018-2026.\n');
console.log(''.padEnd(46), 'AGGRESSIVE (100%)'.padEnd(34), '50% MOM / 50% LOW-VOL (stop on momentum half)');
for (const r of ROWS) console.log(r.nm.padEnd(46), f(r.a).padEnd(34), f(r.m), `| periods agg ${r.a.per.map(x => pct(x).trim()).join(' ')}`);
