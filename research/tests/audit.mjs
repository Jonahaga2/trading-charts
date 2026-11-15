
const out = (...a) => console.log(...a);
const yr = (d, y) => stats(d, first0, [`${y}-01-01`, `${y}-12-31`]).cagr;
out('A) KNOWN-ANSWER CHECKS (total return incl. dividends)');
const sp = series('SPY').daily; out('SPY 2022', pct(yr(sp, 2022)), '(real -18.2%)  2023', pct(yr(sp, 2023)), '(real +26.2%)  2024', pct(yr(sp, 2024)), '(real +24.9%)');
const ser = sym => { const k = syms.indexOf(sym); const o = []; for (let i = first0; i < N; i++) o.push(C[k][i]); return o; };
out('NVDA 2023', pct(yr(ser('NVDA'), 2023)), '(real +239%)  AAPL 2022', pct(yr(ser('AAPL'), 2022)), '(real -26.4%)  META 2022', pct(yr(ser('META'), 2022)), '(real -64.2%)');
out('IEF 2022', pct(yr(series('IEF').daily, 2022)), '(real about -15%)');

out('\nB) UNIVERSE: download kept stocks whose volume EVER hit $20M/day. Matters for the 300 we use?');
let minDv = 1e18; for (const i of monthEnds) { const r = snap.get(i).find(r => r.rank === 299); if (r && r.dv < minDv) minDv = r.dv; }
out(`smallest $ volume of the #300 stock in any month: $${(minDv / 1e6).toFixed(0)}M/day -> ${minDv > 40e6 ? 'no effect' : 'CHECK'}`);
const lastDay = k => { for (let i = N - 1; i >= 0; i--) if (!isNaN(C[k][i])) return i; return -1; };
out(`stocks that stopped trading before the end (delisted/merged): ${syms.filter((_, k) => lastDay(k) < N - 30).length} of ${NS}`);

out('\nC) DUPLICATES (same company under two tickers)');
const sig = new Map(); const dups = [];
for (let k = 0; k < NS; k++) { for (const st of [N - 400, 1300, 900, 500]) { const vals = []; for (let i = st; i < st + 20; i++) vals.push(C[k][i]); if (vals.some(isNaN)) continue;
  const key = st + ':' + vals.map(x => x.toFixed(3)).join(','); if (sig.has(key) && sig.get(key) !== k) dups.push(syms[sig.get(key)] + '=' + syms[k]); else sig.set(key, k); } }
const ud = [...new Set(dups)]; out(`identical 20-day price runs: ${ud.length}${ud.length ? ' -> ' + ud.slice(0, 20).join(' ') : ''}`);

out('\nD) PICKS OF THE BEST PLAN (weekly): anything odd?');
setMulti([0, 5, 10, 15]);
const ds = [...REB.keys()].sort((a, b) => a - b).filter(j => days[j] >= '2018');
let nPick = 0, gaps = 0, dupPick = 0; const bigJ = [], delist = []; const dupSet = new Set(ud.flatMap(d => d.split('=')));
for (let n = 0; n < ds.length - 1; n++) { const j = ds[n], j2 = ds[n + 1], sd = REB.get(j);
  const picks = snap.get(sd).filter(r => r.rank < 300 && r.f.smoothMomR != null && !isNaN(O[r.k][j])).sort((a, b) => b.f.smoothMomR - a.f.smoothMomR).slice(0, 10);
  for (const r of picks) { nPick++; if (dupSet.has(syms[r.k])) dupPick++;
    for (let i = j; i < j2; i++) { if (isNaN(C[r.k][i]) || isNaN(O[r.k][i])) { gaps++; delist.push(`${syms[r.k]} ${days[i]}`); break; }
      const q = C[r.k][i] / (i > j ? C[r.k][i - 1] : O[r.k][j]); if (q > 1.5 || q < 0.5) bigJ.push(`${syms[r.k]} ${days[i]} ${pct(q - 1)}`); } } }
out(`weekly picks checked: ${nPick}; held stock with a missing day: ${gaps} ${[...new Set(delist)].slice(0, 10).join(', ')}`);
out(`one-day moves over +50% or under -50% while held: ${bigJ.length} -> ${bigJ.slice(0, 12).join(' | ')}`);
out(`picks that are a duplicate ticker: ${dupPick}`);

out('\nE) LOOK-AHEAD: recompute picks from data cut off at the signal day');
let same = 0, tested = 0; const sdays = [...snap.keys()].filter(i => days[i] >= '2019').sort((a, b) => a - b);
for (let t = 0; t < 20; t++) { const sd = sdays[Math.floor(t * sdays.length / 20)];
  const a = snap.get(sd).filter(r => r.rank < 300 && r.f.smoothMomR != null).sort((x, y) => y.f.smoothMomR - x.f.smoothMomR).slice(0, 10).map(r => r.k);
  const rows = []; for (let k = 0; k < NS; k++) { const c = C[k].slice(0, sd + 1), v = V[k], rc = rawC[k]; if (!rc || !(rc[sd] >= 3) || isNaN(c[sd - 252]) || isNaN(c[sd - 21])) continue;
    let n = 0, s1 = 0, s2 = 0, dv = 0, n60 = 0, bad = false; for (let j = sd - 251; j <= sd; j++) { if (isNaN(c[j]) || isNaN(c[j - 1])) continue; const q = c[j] / c[j - 1]; if (q > 3 || q < 1 / 3) { bad = true; break; } const lr = Math.log(q); n++; s1 += lr; s2 += lr * lr; if (j > sd - 60) { dv += c[j] * v[j]; n60++; } }
    if (bad || n < 230 || n60 < 40) continue; const vol = Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2) * 252), mom = c[sd - 21] / c[sd - 252] - 1;
    const run = sd >= 756 && !isNaN(c[sd - 756]) ? c[sd - 252] / c[sd - 756] - 1 : null; rows.push({ k, dv: dv / n60, sm: mom / (vol || 1), ok: run == null || run < 2 }); }
  rows.sort((x, y) => y.dv - x.dv); const b = rows.slice(0, 300).filter(r => r.ok).sort((x, y) => y.sm - x.sm).slice(0, 10).map(r => r.k);
  tested++; if (a.join() === b.join()) same++; else out('  differ on', days[sd], a.map(k => syms[k]).join(','), '|', b.map(k => syms[k]).join(',')); }
out(`match: ${same}/${tested}`);

out('\nF) INDEPENDENT REBUILD of the best plan (separate simple code, open-to-open returns)');
const rankW = p => { const v = p.map((_, n) => 10 - n), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 10)); };
const simA = simulate({ feat: 'smoothMomR', bucket: 'large', top: 10, wfun: rankW });
// simple rebuild: hold weights between rebalance opens; return = sum w * (O[j2]/O[j]-1); cost on weight change; delisted -> last close
let val = 1, prevW = new Map(); const curve = []; const allD = [...REB.keys()].sort((a, b) => a - b).filter(j => j >= first0);
for (let n = 0; n < allD.length - 1; n++) { const j = allD[n], j2 = allD[n + 1], sd = REB.get(j);
  const picks = snap.get(sd).filter(r => r.rank < 300 && r.f.smoothMomR != null && !isNaN(O[r.k][j])).sort((a, b) => b.f.smoothMomR - a.f.smoothMomR).slice(0, 10);
  const w = new Map(picks.map((r, i) => [r.k, rankW(picks)[i]])); let turn = 0; for (const k of new Set([...w.keys(), ...prevW.keys()])) turn += Math.abs((w.get(k) || 0) - (prevW.get(k) || 0));
  val *= 1 - turn * 0.0005; let g = 0, cashW = 1; const nw = new Map();
  for (const [k, wk] of w) { let e = O[k][j2]; if (isNaN(e)) { let q = j2 - 1; while (q > j && isNaN(C[k][q])) q--; e = C[k][q]; } const rr = e / O[k][j] - 1; g += wk * rr; cashW -= wk; nw.set(k, wk * (1 + rr)); }
  g += cashW * (bilO[j2] / bilO[j] - 1); val *= 1 + g; const tot = 1 + g; for (const [k, x] of nw) nw.set(k, x / tot); prevW = nw; curve.push([days[j2], val]); }
const cg = (a, b) => { const s = curve.find(c => c[0] >= a), e = [...curve].reverse().find(c => c[0] <= b); return (e[1] / s[1]) ** (365.25 * 864e5 / (Date.parse(e[0]) - Date.parse(s[0]))) - 1; };
for (const p of [['2018-01-01', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2099'], ['2018-01-01', '2099']]) out(`${p[0].slice(0, 4)}-${p[1].slice(0, 4)}  main simulator ${pct(stats(simA.daily, first0, p).cagr)}   rebuild ${pct(cg(...p))}`);
