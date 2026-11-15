const lastDay = k => { for (let i = N - 1; i >= 0; i--) if (!isNaN(C[k][i])) return i; return -1; };
const firstDay = k => { for (let i = 0; i < N; i++) if (!isNaN(C[k][i])) return i; return -1; };
const P = ['NN=TMTS','APXT=AVPT','HYAC=RMIX','ARCI=AIFC','PEW=CLBR','AIFC=ALTS','NAUT=ARYA','CDRO=DDMX','NXDR=KIND','OPCH=BIOS','ZSQR=COEP','PGEN=XON','GRAB=AGC','SLNG=AETI','PPLI=IAC','PRTH=MACQ','TDAY=NEWM','FLNA=PTIE','ANIX=ITUS','QBTS=XPOA'].map(p => p.split('='));
let overlapDays = 0;
for (const [a, b] of P) { const ka = syms.indexOf(a), kb = syms.indexOf(b); let ov = 0; for (let i = 0; i < N; i++) if (!isNaN(C[ka][i]) && !isNaN(C[kb][i])) ov++;
  console.log(`${a.padEnd(5)} ${days[firstDay(ka)]}..${days[lastDay(ka)]}   ${b.padEnd(5)} ${days[firstDay(kb)]}..${days[lastDay(kb)]}   both trading ${ov} days`); overlapDays += ov; }
setMulti([0, 5, 10, 15]); const dupK = new Map(P.flatMap(([a, b]) => [[syms.indexOf(a), b], [syms.indexOf(b), a]]));
let both = 0, tot = 0;
for (const [j, sd] of REB) { if (days[j] < '2018') continue; const picks = snap.get(sd).filter(r => r.rank < 300 && r.f.smoothMomR != null && !isNaN(O[r.k][j])).sort((a, b) => b.f.smoothMomR - a.f.smoothMomR).slice(0, 10); tot++;
  const ks = new Set(picks.map(r => r.k)); for (const r of picks) { const o = dupK.get(r.k); if (o && ks.has(syms.indexOf(o))) { both++; console.log('BOTH COPIES HELD', days[j], syms[r.k], o); } } }
console.log(`weeks where both copies of one company were held: ${both / 2} of ${tot}`);
