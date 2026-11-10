/* Checks for the paper-trading rule and order planner. No network.
   Run: node scanner/paper.test.mjs */
import { score, pickMomentum, targetWeights, planOrders, isFirstSession, RULE } from './paper.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// A series that grows by `g` a day with a ±w wiggle, `n` closes long.
const grow = (g, w = 0.01, n = 300, p0 = 50, vol = 1e6) => {
  const c = [p0]; for (let i = 1; i < n; i++) c.push(c[i - 1] * (1 + g + (i % 2 ? w : -w)));
  return { c, v: Array(n).fill(vol) };
};

// score: momentum is the 12-1 return, read off the right closes.
{
  const s = grow(0.002); const L = s.c.length - 1, x = score(s.c, s.v);
  check('momentum = close 21 sessions ago ÷ close 252 sessions ago − 1', near(x.mom, s.c[L - 21] / s.c[L - 252] - 1));
  check('smooth = momentum ÷ volatility', near(x.smooth, x.mom / x.vol));
  check('volatility is annualised', x.vol > 0.1 && x.vol < 0.25, x.vol);
  check('needs a year of history', score(s.c.slice(0, 200), s.v.slice(0, 200)) === null);
  const bad = grow(0.001); bad.c[280] = bad.c[279] * 5;
  check('a 5× one-day jump (bad print) rules the stock out', score(bad.c, bad.v) === null);
  const lastMonth = grow(0.001); for (let i = 280; i < 300; i++) lastMonth.c[i] = lastMonth.c[279] * (1 + (i - 279) * 0.05);
  check('the last month is skipped (it does not move momentum)', near(score(lastMonth.c, lastMonth.v).mom, score(grow(0.001).c, grow(0.001).v).mom));
}

// pickMomentum: liquid first, then smoothest climb; $3 floor.
{
  const m = new Map();
  for (let k = 0; k < 400; k++) m.set('S' + k, grow(0.0005 + k * 0.00001, 0.01, 300, 50, 1e6 + (400 - k) * 1e4));   // higher k: faster but thinner
  m.set('THIN', grow(0.01, 0.01, 300, 50, 10));                // fastest climber, no volume
  m.set('PENNY', grow(0.003, 0.01, 300, 0.5, 1e9));            // liquid, climbing, under $3 at the end
  const picks = pickMomentum(m);
  check('picks 10', picks.length === RULE.top);
  check('only the 300 most-traded are eligible', !picks.some(p => p.sym === 'THIN') && picks.every(p => +p.sym.slice(1) < 300), picks.map(p => p.sym).join());
  check('under $3 is out', !picks.some(p => p.sym === 'PENNY'));
  check('best momentum among the eligible wins', picks[0].sym === 'S299', picks[0].sym);
  check('sorted best first', picks.every((p, i) => !i || picks[i - 1].smooth >= p.smooth));
}

// targetWeights: 30% SPY, 20% bonds, 5% each of 10.
{
  const w = targetWeights(Array.from({ length: 10 }, (_, i) => ({ sym: 'X' + i })));
  check('SPY 30%', w.SPY === 0.3);
  check('bonds (IEF) 20%', w.IEF === 0.2);
  check('each pick 5%', Object.entries(w).filter(([s]) => s !== 'SPY' && s !== 'IEF').every(([, x]) => near(x, 0.05)));
  check('weights sum to 1', near(Object.values(w).reduce((a, b) => a + b, 0), 1));
  const few = targetWeights([{ sym: 'A' }, { sym: 'B' }]);
  check('fewer than 10 picks: still 5% each, rest stays cash', near(few.A, 0.05) && near(few.B, 0.05));
}

// planOrders.
{
  const weights = { SPY: 0.5, AAA: 0.25, BBB: 0.25 };
  const empty = planOrders({ equity: 100000, positions: [], weights });
  check('from cash: buys only', empty.sells.length === 0 && empty.buys.length === 3);
  check('keeps a 1% buffer', near(empty.buys.reduce((a, b) => a + b.notional, 0), 99000, 0.05));
  const held = [{ symbol: 'SPY', qty: '100', market_value: '49500' }, { symbol: 'OLD', qty: '10', market_value: '20000' }, { symbol: 'AAA', qty: '50', market_value: '30000' }];
  const p = planOrders({ equity: 100000, positions: held, weights });
  check('a stock no longer picked is sold in full', p.sells.some(s => s.symbol === 'OLD' && s.all));
  check('an overweight one is trimmed by quantity', p.sells.some(s => s.symbol === 'AAA' && near(s.qty, 50 * (30000 - 24750) / 30000, 1e-5)));
  check('a position already on target is left alone', !p.buys.some(b => b.symbol === 'SPY') && !p.sells.some(s => s.symbol === 'SPY'));
  check('a new pick is bought', p.buys.some(b => b.symbol === 'BBB' && near(b.notional, 24750, 0.01)));
  const tiny = planOrders({ equity: 100000, positions: [{ symbol: 'SPY', qty: '1', market_value: '49300' }], weights: { SPY: 0.5 } });
  check('changes under 0.5% of equity are skipped', tiny.buys.length === 0 && tiny.sells.length === 0);
}

// isFirstSession: holidays push the first session later.
{
  const cal = [{ date: '2026-01-02' }, { date: '2026-01-05' }];
  check('Jan 2 is the first session of January 2026', isFirstSession('2026-01-02', cal));
  check('Jan 5 is not', !isFirstSession('2026-01-05', cal));
  check('a month starting on a weekend', isFirstSession('2026-11-02', [{ date: '2026-11-02' }, { date: '2026-11-03' }]));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
