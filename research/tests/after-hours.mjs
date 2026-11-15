const rankW = p => { const v = p.map((_, n) => 10 - n), t = v.reduce((a, b) => a + b, 0); return v.map(x => x / t * Math.min(1, p.length / 10)); };
// Percentile combos among the liquid 300, per signal day
for (const [, rows] of snap) { const liq = rows.filter(r => r.rank < 300 && r.f.smoothMom != null);
  const pr = key => { const h = [...liq].sort((a, b) => a.f[key] - b.f[key]); h.forEach((r, n) => { (r.q ||= {})[key] = n / Math.max(1, h.length - 1); }); };
  for (const key of ['smoothMom', 'onMom', 'inMom', 'on21', 'on5']) pr(key);
  const momTop30 = new Set([...liq].sort((a, b) => b.f.smoothMom - a.f.smoothMom).slice(0, 30).map(r => r.k));
  for (const r of rows) { const f = r.f, ok = f.ret3y == null || f.ret3y < 2, q = r.q || {};
    f.A = ok ? f.smoothMom : null;
    f.ON = ok ? f.onMom : null;                                     // after-hours momentum only
    f.IN = ok ? f.inMom : null;                                     // regular-hours momentum only
    f.ONPOS = ok && f.onMom > 0 ? f.smoothMom : null;               // momentum, only if gains came after hours too
    f.MIX = ok && q.smoothMom != null ? q.smoothMom + q.onMom : null;   // blend momentum + after-hours momentum
    f.MIX2 = ok && q.smoothMom != null ? q.smoothMom + 0.5 * q.onMom : null;
    f.GAP5 = ok && momTop30.has(r.k) ? f.on5 : null;                 // top-30 momentum, strongest after-hours last week
    f.GAP21 = ok && momTop30.has(r.k) ? f.on21 : null;              // top-30 momentum, strongest after-hours last month
    f.NOBAD = ok && f.on5 > -0.05 ? f.smoothMom : null;             // momentum, skip if after-hours dumped 5%+ last week
    f.BADNEWS = ok && f.on21 > -0.08 ? f.smoothMom : null;          // skip if after-hours dumped 8%+ last month
  } }
const B = feat => ({ feat, bucket: 'large', top: 10, wfun: rankW });
const NAMES = { A: 'CURRENT (momentum)', ON: 'after-hours momentum only', IN: 'regular-hours momentum only', ONPOS: 'momentum + after-hours gains > 0', MIX: 'momentum + after-hours (50/50 blend)', MIX2: 'momentum + after-hours (2:1 blend)',
  GAP5: 'top-30 momentum, best after-hours last week', GAP21: 'top-30 momentum, best after-hours last month', NOBAD: 'skip if after-hours dropped 5%+ last week', BADNEWS: 'skip if after-hours dropped 8%+ last month' };
console.log('AGGRESSIVE (100% stocks, weekly, rank weights):');
for (const [k, nm] of Object.entries(NAMES)) go(nm, B(k), 'weekly', 1);
console.log('\nMAIN PLAN (50/30/20, weekly, rank weights):');
for (const k of ['A', 'ON', 'MIX', 'MIX2', 'ONPOS', 'NOBAD']) go(NAMES[k], B(k), 'weekly', 0.5);
// Where do momentum picks earn their money? split each held week into overnight vs regular hours
setMulti([0, 5, 10, 15]); let gOn = 0, gIn = 0;
const dsx = [...REB.keys()].sort((a, b) => a - b).filter(j => days[j] >= '2018');
for (let n = 0; n < dsx.length - 1; n++) { const j = dsx[n], j2 = dsx[n + 1]; const picks = snap.get(REB.get(j)).filter(r => r.rank < 300 && r.f.A != null && !isNaN(O[r.k][j])).sort((a, b) => b.f.A - a.f.A).slice(0, 10);
  for (const r of picks) for (let i = j; i < j2; i++) { if (isNaN(C[r.k][i]) || isNaN(O[r.k][i])) break; gIn += Math.log(C[r.k][i] / O[r.k][i]); if (i + 1 < j2 && !isNaN(O[r.k][i + 1])) gOn += Math.log(O[r.k][i + 1] / C[r.k][i]); } }
console.log(`\nOur picks' gains split (log points summed): after hours/overnight ${gOn.toFixed(1)} vs regular hours ${gIn.toFixed(1)}`);
