/* ═══════════════════════════════════════════════════════════════════════
   Backtest of the dip picks, with a stop loss
   ───────────────────────────────────────────────────────────────────────
   Replays the picks rule (scanner/charts.mjs PICK, evaluated with the same
   src/scan.js the nightly job uses) over years of daily bars:

   • Signal: at a day's close, a stock passes the rule *and* crossed the
     recovery line that day (`fresh`, as the picks list it). Each day takes at
     most the top `--top` signals by the same order as the picks.
   • Entry: next session's open. No look-ahead.
   • Exit, whichever comes first:
       stop     — low touches entry × (1 − stop). Filled at the stop, or at
                  the open if it gaps through.
       target   — (optional) high reaches the old peak. Filled at the target,
                  or the open if it gaps over. On a day that touches both,
                  the stop is assumed hit first.
       time     — close of the `--hold`-th session.
   • One open trade per symbol at a time.

   Portfolio: `--slots` equal positions; a signal with no free slot is
   skipped. Each entry takes equity / slots. No commissions or slippage.

   Caveat stated in the output: the universe is today's listed stocks, so
   companies that collapsed and delisted are missing (survivorship bias),
   which flatters any dip-buying test.

     ALPACA_KEY=… ALPACA_SECRET=… node scanner/backtest.mjs --from 2021-01-01
   ═══════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseUniverse } from './run.mjs';
import { PICK } from './charts.mjs';

const require = createRequire(import.meta.url);
const SCAN = require('../src/scan.js');

/* ── Signals ──────────────────────────────────────────────────────────
   series: { s, t: [iso], o, h, l, c, v } arrays oldest first.
   Returns [{ s, i, drop, ... }] for every day the rule fires fresh. */
export function signals(series, rule = PICK) {
  const { o, h, l, c, v } = series, n = c.length, out = [];
  // Rolling 20-day average dollar volume, as the scan computes it.
  const dv = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += c[i] * v[i];
    if (i >= 20) sum -= c[i - 20] * v[i - 20];
    dv[i] = sum / Math.min(i + 1, 20);
  }
  for (let i = rule.lookback; i < n; i++) {
    if (c[i] < rule.minPrice || dv[i] < rule.minDollarVol) continue;   // cheap checks first
    const m = SCAN.evaluate({ h: h.subarray(0, i + 1), l: l.subarray(0, i + 1), c: c.subarray(0, i + 1), dv: dv[i] }, rule);
    if (m && m.pass && m.fresh) out.push({ s: series.s, i, day: series.t[i], drop: m.drop, retrace: m.retrace, peak: m.peak, jump: m.jump, dv: dv[i] });
  }
  return out;
}

/* One trade from the bar after signal i. */
export function trade(series, sig, { stop = 0.15, hold = 20, target = false } = {}) {
  const { o, h, l, c, t } = series, e = sig.i + 1;
  if (e >= c.length) return null;
  const entry = o[e], stopPx = entry * (1 - stop), tgt = target ? sig.peak : Infinity;
  for (let k = e; k < c.length && k < e + hold; k++) {
    if (l[k] <= stopPx) return { exit: Math.min(o[k], stopPx), k, why: 'stop', entry, e };
    if (h[k] >= tgt) return { exit: Math.max(o[k], tgt), k, why: 'target', entry, e };
  }
  const k = Math.min(c.length - 1, e + hold - 1);
  // A trade still open at the end of the data is marked at the last close.
  return { exit: c[k], k, why: k === e + hold - 1 ? 'time' : 'open', entry, e };
}

/* Replay: signals by day, top N a day, slot-limited portfolio. */
export function simulate(all, sigs, { top = 5, slots = 5, ...exit } = {}) {
  const byDay = new Map();
  for (const g of sigs) (byDay.get(g.day) || byDay.set(g.day, []).get(g.day)).push(g);
  const days = [...byDay.keys()].sort();
  const trades = [];
  const busyUntil = new Map();                         // symbol → exit date
  let open = [];                                       // { exitDay, value }
  let cash = 1, equity = 1;
  for (const d of days) {
    // Close trades that exited on or before this signal day.
    open = open.filter(p => {
      if (p.exitDay > d) return true;
      cash += p.value; return false;
    });
    equity = cash + open.reduce((s, p) => s + p.cost, 0);
    const today = byDay.get(d).sort((a, b) => b.drop - a.drop).slice(0, top);
    for (const g of today) {
      if (open.length >= slots) break;
      if ((busyUntil.get(g.s) || '') > d) continue;
      const tr = trade(all.get(g.s), g, exit);
      if (!tr) continue;
      const ser = all.get(g.s), ret = tr.exit / tr.entry - 1;
      const cost = equity / slots;
      cash -= cost;
      open.push({ exitDay: ser.t[tr.k], value: cost * (1 + ret), cost });
      busyUntil.set(g.s, ser.t[tr.k]);
      trades.push({ s: g.s, in: ser.t[tr.e], out: ser.t[tr.k], ret, why: tr.why, days: tr.k - tr.e + 1 });
    }
  }
  for (const p of open) cash += p.value;
  return { trades, final: cash };
}

/* ── Confidence-sized dollars ─────────────────────────────────────────
   Four checks, a point each, all known at the signal's close:
     market    SPY closed above its 50-day average
     steady    no day since the low was up more than 6%
     liquid    $200M+ traded a day
     strong    60%+ of the fall won back
   Points → dollars: 0 $100, 1 $200, 2 $300, 3 $400, 4 $500 (the cap), never
   more than the cash on hand. The report shows each score's own results, so
   whether more points really meant better trades is measured, not assumed. */
export const SIZES = [100, 200, 300, 400, 500];
export function confidence(g, spyUp) {
  return (spyUp ? 1 : 0) + (g.jump <= 6 ? 1 : 0) + (g.dv >= 2e8 ? 1 : 0) + (g.retrace >= 60 ? 1 : 0);
}

export function simulateDollars(all, sigs, { start = 2000, maxPer = 500, sizes = SIZES, top = 5, spyUp = new Map(), ...exit } = {}) {
  const byDay = new Map();
  for (const g of sigs) (byDay.get(g.day) || byDay.set(g.day, []).get(g.day)).push(g);
  const days = [...byDay.keys()].sort();
  const trades = [], busyUntil = new Map();
  let open = [], cash = start, peakEq = start, maxDD = 0;
  for (const d of days) {
    open = open.filter(p => { if (p.exitDay > d) return true; cash += p.proceeds; return false; });
    const eq = cash + open.reduce((s, p) => s + p.size, 0);       // at cost: realised P&L only
    peakEq = Math.max(peakEq, eq); maxDD = Math.max(maxDD, 1 - eq / peakEq);
    const today = byDay.get(d).sort((a, b) => b.drop - a.drop).slice(0, top);
    for (const g of today) {
      if ((busyUntil.get(g.s) || '') > d) continue;
      const score = confidence(g, spyUp.get(d));
      const size = Math.min(maxPer, sizes[score], cash);
      if (size < 50) continue;                                       // not enough cash for a meaningful position
      const tr = trade(all.get(g.s), g, exit);
      if (!tr) continue;
      const ser = all.get(g.s), ret = tr.exit / tr.entry - 1;
      cash -= size;
      open.push({ exitDay: ser.t[tr.k], proceeds: size * (1 + ret), size });
      busyUntil.set(g.s, ser.t[tr.k]);
      trades.push({ s: g.s, in: ser.t[tr.e], out: ser.t[tr.k], ret, pnl: size * ret, size, score, why: tr.why, days: tr.k - tr.e + 1 });
    }
  }
  for (const p of open) cash += p.proceeds;
  return { trades, final: cash, maxDD };
}

export function stats(trades) {
  const r = trades.map(x => x.ret).sort((a, b) => a - b), n = r.length;
  if (!n) return { n: 0 };
  const wins = r.filter(x => x > 0);
  const avg = r.reduce((s, x) => s + x, 0) / n;
  const gw = wins.reduce((s, x) => s + x, 0), gl = -r.filter(x => x <= 0).reduce((s, x) => s + x, 0);
  return { n, win: wins.length / n, avg, median: r[Math.floor(n / 2)], pf: gl ? gw / gl : Infinity,
    stops: trades.filter(x => x.why === 'stop').length / n, avgDays: trades.reduce((s, x) => s + x.days, 0) / n };
}

/* ── Data ─────────────────────────────────────────────────────────── */
async function fetchDaily(symbols, { key, secret, from, cacheDir }) {
  const all = new Map();
  const batches = [];
  for (let i = 0; i < symbols.length; i += 200) batches.push(symbols.slice(i, i + 200));
  const end = new Date(Date.now() - 16 * 60e3).toISOString();
  let next = 0, done = 0;
  async function worker() {
    while (next < batches.length) {
      const bi = next++, batch = batches[bi];
      const file = path.join(cacheDir, `b${bi}-${from}.json`);
      let data;
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
      else {
        data = {};
        const base = `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(batch.join(','))}`
          + `&timeframe=1Day&start=${from}&end=${encodeURIComponent(end)}&limit=10000&feed=sip&adjustment=all&sort=asc`;
        let token = null;
        for (let page = 0; page < 2000; page++) {
          let r;
          for (let t = 0; t < 5; t++) {
            r = await fetch(base + (token ? `&page_token=${encodeURIComponent(token)}` : ''),
              { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
            if (r.ok || (r.status !== 429 && r.status < 500)) break;
            await new Promise(res => setTimeout(res, 1000 * 2 ** t));
          }
          if (!r.ok) throw new Error(`Alpaca HTTP ${r.status}`);
          const j = await r.json();
          for (const [s, list] of Object.entries(j.bars || {}))
            for (const x of list) ((data[s] ||= { t: [], o: [], h: [], l: [], c: [], v: [] }),
              data[s].t.push(x.t.slice(0, 10)), data[s].o.push(x.o), data[s].h.push(x.h),
              data[s].l.push(x.l), data[s].c.push(x.c), data[s].v.push(x.v));
          token = j.next_page_token;
          if (!token) break;
        }
        fs.writeFileSync(file, JSON.stringify(data));
      }
      for (const [s, d] of Object.entries(data))
        all.set(s, { s, t: d.t, o: Float64Array.from(d.o), h: Float64Array.from(d.h), l: Float64Array.from(d.l),
          c: Float64Array.from(d.c), v: Float64Array.from(d.v) });
      process.stderr.write(`\rdata ${++done}/${batches.length} batches`);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  process.stderr.write('\n');
  return all;
}

/* ── CLI ──────────────────────────────────────────────────────────── */
async function main() {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  const from = a.from || '2021-01-01', stop = (+a.stop || 15) / 100;
  const cacheDir = path.resolve(a.cache || '.scan/bt-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = process.env.ALPACA_KEY, secret = process.env.ALPACA_SECRET;

  const dir = 'https://www.nasdaqtrader.com/dynamic/SymDir/';
  const [nq, ot] = await Promise.all(['nasdaqlisted.txt', 'otherlisted.txt'].map(f => fetch(dir + f).then(r => r.text())));
  const syms = [...parseUniverse(nq, ot).map(u => u.s), 'SPY'];
  const all = await fetchDaily(syms, { key, secret, from, cacheDir });

  const t0 = Date.now();
  const sigs = [];
  for (const [s, ser] of all) if (s !== 'SPY') sigs.push(...signals(ser));
  console.error(`${sigs.length} signals from ${all.size} symbols in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const spy = all.get('SPY');
  const spyAt = new Map(spy.t.map((d, i) => [d, i]));
  const spyRet = tr => {
    const i = spyAt.get(tr.in), k = spyAt.get(tr.out);
    return i != null && k != null ? spy.c[k] / spy.o[i] - 1 : 0;
  };
  const years = (Date.parse(spy.t.at(-1)) - Date.parse(spy.t[0])) / (365.25 * 864e5);
  const spyTotal = spy.c.at(-1) / spy.o[0] - 1;
  const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

  const variants = [
    ['Sell at old high (max 60 days)', { stop, hold: 60, target: true }],
    ['Hold 20 days', { stop, hold: 20 }],
    ['Hold 60 days', { stop, hold: 60 }],
    ['Hold 20 days, NO stop', { stop: 1, hold: 20 }],
  ];
  // SPY above its 50-day average, by day — the "market" confidence point.
  const spyUp = new Map();
  for (let i = 49; i < spy.c.length; i++) {
    let s = 0; for (let k = i - 49; k <= i; k++) s += spy.c[k];
    spyUp.set(spy.t[i], spy.c[i] > s / 50);
  }
  const start = +a.start || 2000, maxPer = +a.max || 500;
  const usd = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(0);
  const report = { from: spy.t[0], to: spy.t.at(-1), years, spyTotal, signals: sigs.length, start, maxPer, variants: [] };
  console.log(`\nBacktest ${spy.t[0]} → ${spy.t.at(-1)} (${years.toFixed(1)} yrs) · $${start} start · confidence-sized, max $${maxPer}/stock · stop ${stop * 100}%`);
  console.log(`SPY: $${start} → ${usd(start * (1 + spyTotal))} (${pct((1 + spyTotal) ** (1 / years) - 1)}/yr)\n`);
  for (const [name, exit] of variants) {
    const ds = simulateDollars(all, sigs, { start, maxPer, top: 5, spyUp, ...exit });
    const sc = [0, 1, 2, 3, 4].map(k => {
      const t = ds.trades.filter(x => x.score === k);
      return t.length ? `${k}pt ${t.length} trades avg ${pct(t.reduce((s, x) => s + x.ret, 0) / t.length)}` : null;
    }).filter(Boolean).join(' · ');
    console.log(`${name}: $${start} → ${usd(ds.final)} (${pct((ds.final / start) ** (1 / years) - 1)}/yr) · `
      + `${ds.trades.length} trades · win ${pct(stats(ds.trades).win).slice(1)} · worst dip ${pct(-ds.maxDD)}`);
    console.log(`   by confidence: ${sc}`);
    report.variants.push({ name, dollars: { final: ds.final, maxDD: ds.maxDD, trades: ds.trades.length,
      byScore: [0, 1, 2, 3, 4].map(k => { const t = ds.trades.filter(x => x.score === k); return { k, n: t.length, avg: t.length ? t.reduce((s, x) => s + x.ret, 0) / t.length : null, pnl: t.reduce((s, x) => s + x.pnl, 0) }; }) } });
  }
  console.log('\n— Equal-weight version (5 slots, % of equity), for comparison —');
  for (const [name, exit] of variants) {
    const sim = simulate(all, sigs, { top: 5, slots: 5, ...exit });
    const st = stats(sim.trades);
    const excess = sim.trades.reduce((s, tr) => s + tr.ret - spyRet(tr), 0) / (sim.trades.length || 1);
    const cagr = sim.final ** (1 / years) - 1;
    const byYear = {};
    for (const tr of sim.trades) { const y = tr.out.slice(0, 4); (byYear[y] ||= []).push(tr.ret); }
    console.log(`${name}: ${st.n} trades · win ${pct(st.win).slice(1)} · avg ${pct(st.avg)} · median ${pct(st.median)} · `
      + `vs SPY ${pct(excess)}/trade · stopped ${pct(st.stops).slice(1)} · ${st.avgDays.toFixed(0)}d avg · `
      + `portfolio ${pct(sim.final - 1)} (${pct(cagr)}/yr)`);
    console.log('   by year: ' + Object.entries(byYear).sort().map(([y, r]) => `${y} ${pct(r.reduce((s, x) => s + x, 0) / r.length)} (${r.length})`).join(' · '));
    report.variants.find(v => v.name === name).equal = ({ exit, ...st, excess, final: sim.final, cagr, byYear: Object.fromEntries(Object.entries(byYear).map(([y, r]) => [y, { n: r.length, avg: r.reduce((s, x) => s + x, 0) / r.length }])) });
  }
  console.log('\nCaveats: today\'s listed stocks only (delisted companies missing → flatters results); no commissions or slippage.');
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(report, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
