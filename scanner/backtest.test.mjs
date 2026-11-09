/* Checks for the backtest's trade mechanics and portfolio. No network.
   Run: node scanner/backtest.test.mjs */
import { trade, signals, simulate, simulateDollars, confidence, stats } from './backtest.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Bars from [o, h, l, c] rows; dates are sequential.
const ser = (s, rows) => ({
  s, t: rows.map((_, i) => new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10)),
  o: Float64Array.from(rows.map(r => r[0])), h: Float64Array.from(rows.map(r => r[1])),
  l: Float64Array.from(rows.map(r => r[2])), c: Float64Array.from(rows.map(r => r[3])),
  v: Float64Array.from(rows.map(() => 1e7)),
});
const sig = (i, peak = 200) => ({ s: 'X', i, peak });

// Signal at bar 0 → entry at bar 1's open (100).
{
  const stopped = ser('X', [[90, 95, 88, 92], [100, 101, 95, 96], [96, 97, 84, 85], [85, 90, 80, 88]]);
  const t = trade(stopped, sig(0), { stop: 0.15, hold: 20 });
  check('enters at the next open', t.entry === 100);
  check('stop fills at the stop price', t.why === 'stop' && near(t.exit, 85) && t.k === 2);

  const gap = ser('X', [[90, 95, 88, 92], [100, 101, 95, 96], [80, 82, 78, 81]]);
  const g = trade(gap, sig(0), { stop: 0.15, hold: 20 });
  check('a gap through the stop fills at the open', g.why === 'stop' && g.exit === 80);

  const up = ser('X', [[90, 95, 88, 92], [100, 105, 99, 104], [104, 125, 103, 120]]);
  const u = trade(up, sig(0, 120), { stop: 0.15, hold: 20, target: true });
  check('target fills at the old high', u.why === 'target' && u.exit === 120 && u.k === 2);

  const both = ser('X', [[90, 95, 88, 92], [100, 130, 80, 100]]);
  check('a day touching both counts as stopped', trade(both, sig(0, 120), { stop: 0.15, hold: 20, target: true }).why === 'stop');

  const flat = ser('X', [[90, 95, 88, 92], ...Array(10).fill([100, 102, 98, 101])]);
  const f = trade(flat, sig(0), { stop: 0.15, hold: 5 });
  check('time exit at the close of the hold-th session', f.why === 'time' && f.k === 5 && f.exit === 101);
  const nostop = trade(stopped, sig(0), { stop: 1, hold: 3 });
  check('stop 100% = no stop', nostop.why === 'time' && nostop.exit === 88);
  check('no bar after the signal → no trade', trade(flat, sig(10), { hold: 5 }) === null);
}

// signals(): fires once, on the day the steady recovery crosses 50%.
{
  const closes = [...Array(70).fill(100), 50, 54, 58, 62, 66, 70, 74, 78];   // 50% back at 75
  const rows = closes.map(c => [c, c, c, c]);
  const sg = signals(ser('Y', rows));
  check('signal fires on the crossing day only', sg.length === 1 && sg[0].i === 77, JSON.stringify(sg.map(x => x.i)));
  const spiky = [...Array(70).fill(100), 50, 52, 76, 77];                     // +46% in one day
  check('a one-day spike gives no signal', signals(ser('Z', spiky.map(c => [c, c, c, c]))).length === 0);
}

// simulate(): slots and one trade per symbol at a time.
{
  const mk = s => ser(s, [[50, 50, 50, 50], ...Array(30).fill([100, 101, 99, 100])]);
  const all = new Map(['A', 'B', 'C'].map(s => [s, mk(s)]));
  const day = all.get('A').t[0];
  const sigs = ['A', 'B', 'C'].map((s, k) => ({ s, i: 0, day, drop: 50 - k, peak: 200 }));
  const one = simulate(all, sigs, { top: 5, slots: 2, stop: 0.15, hold: 5 });
  check('slots cap open trades', one.trades.length === 2 && one.trades.map(t => t.s).join() === 'A,B');
  const dup = simulate(all, [sigs[0], { ...sigs[0], i: 1, day: all.get('A').t[1] }], { top: 5, slots: 5, stop: 0.15, hold: 5 });
  check('one open trade per symbol', dup.trades.length === 1);
  const st = stats([{ ret: 0.1, why: 'time', days: 5 }, { ret: -0.15, why: 'stop', days: 2 }, { ret: 0.2, why: 'target', days: 9 }]);
  check('stats', near(st.win, 2 / 3) && near(st.avg, 0.05 / 1) && near(st.pf, 0.3 / 0.15) && near(st.stops, 1 / 3));
}

// Confidence points and dollar sizing.
{
  const g = { jump: 5, dv: 3e8, retrace: 65 };
  check('confidence: all four points', confidence(g, true) === 4);
  check('confidence: none', confidence({ jump: 9, dv: 1e8, retrace: 55 }, false) === 0);
  check('confidence: market only', confidence({ jump: 9, dv: 1e8, retrace: 55 }, true) === 1);

  // Five symbols, all signalling on day 0, flat afterwards (time exit at 0%).
  const mk = s => ser(s, [[50, 50, 50, 50], ...Array(30).fill([100, 101, 99, 100])]);
  const syms = ['A', 'B', 'C', 'D', 'E'];
  const all = new Map(syms.map(s => [s, mk(s)]));
  const day = all.get('A').t[0];
  const hi = { jump: 5, dv: 3e8, retrace: 65 }, lo = { jump: 9, dv: 1e8, retrace: 55 };
  const sigs = syms.map((s, k) => ({ s, i: 0, day, drop: 50 - k, peak: 200, ...(k === 0 ? hi : lo) }));
  const spyUp = new Map([[day, false]]);
  const r = simulateDollars(all, sigs, { start: 2000, maxPer: 500, top: 5, spyUp, stop: 0.15, hold: 5 });
  check('dollars: high confidence gets the $500 cap... minus the missing market point', r.trades[0].size === 400 && r.trades[0].score === 3);
  check('dollars: low confidence gets $100', r.trades[1].size === 100 && r.trades[1].score === 0);
  const capped = simulateDollars(all, sigs.map(x => ({ ...x, ...hi })), { start: 2000, maxPer: 500, top: 5, spyUp: new Map([[day, true]]), stop: 0.15, hold: 5 });
  check('dollars: never more than $500 a stock', capped.trades.every(t => t.size <= 500));
  check('dollars: never more than the cash on hand', capped.trades.reduce((s, t) => s + t.size, 0) <= 2000 && capped.trades.length === 4);
  check('dollars: flat trades return the stake', Math.abs(capped.final - 2000) < 1e-6);
  const blocked = simulateDollars(all, sigs, { start: 2000, top: 5, spyUp, allow: new Map([[day, false]]), stop: 0.15, hold: 5 });
  check('market filter: no buys on a down day', blocked.trades.length === 0 && blocked.final === 2000);
  const allowed = simulateDollars(all, sigs, { start: 2000, top: 5, spyUp, allow: new Map([[day, true]]), stop: 0.15, hold: 5 });
  check('market filter: buys on an up day', allowed.trades.length === 5);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
