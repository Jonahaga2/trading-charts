#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   SCAN — run one rule across a whole universe
   ───────────────────────────────────────────────────────────────────────
     node backtest/scan.mjs --dir data/ --strategy bounce --costs 10
     node backtest/scan.mjs --dir data/ --universe float.csv --max-positions 5

   A screen that fires a handful of times per symbol per decade cannot be
   judged one symbol at a time — 26 trades is a story, not a sample. This
   runs the rule over every csv in a directory, pools the trades, and asks
   the only question that matters first: does the setup have an edge?

   Two answers come out, and they answer different questions.

   POOLED TRADE STATISTICS treat every trade as one draw from the same
   distribution, which is what a screen is: a claim that a certain setup
   pays. Win rate, average win, average loss, and from those the breakeven
   win rate — the number the strategy has to beat to be worth trading at
   all. This is sizing-free, so no allocation assumption can flatter it.

   THE PORTFOLIO run then asks what it would have done to an account:
   equal stakes, a cap on concurrent positions, signals skipped when every
   slot is full. Expect the cap to bind on a real universe: a month in which
   everything is down 10% is the same month for every name at once, so the
   signals should arrive in clusters and the portfolio will take fewer of
   them than the pooled statistics count. How much fewer is an empirical
   question — it depends on how many names you scan and how many slots you
   run — and the run reports it rather than assuming it. Where the two
   diverge, the gap is not an error; it is the cost of finite capital in a
   correlated market.

   The equity curve here is realised-only: it steps when a trade closes,
   and open positions are carried at cost. Drawdown measured on it is
   therefore optimistic — it cannot see the dip a position took before it
   recovered. Read it as a ledger, not as a mark-to-market curve.
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { runBacktest } from './engine.mjs';
import { computeMetrics, drawdown } from './metrics.mjs';
import { loadCsv, slice } from './data.mjs';
import { REFERENCE, monthlyBounce } from './strategies.mjs';
import { parseUniverse, makeScreen } from './universe.mjs';

function parseArgs(argv) {
  const a = { strategy: 'bounce', cash: 100_000, maxPositions: 5, costs: null };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--dir':            a.dir = next(); break;
      case '--strategy':       a.strategy = next(); break;
      case '--universe':       a.universeFile = next(); break;
      case '--from':           a.from = next(); break;
      case '--to':             a.to = next(); break;
      case '--costs':          a.costs = +next(); break;
      case '--cash':           a.cash = +next(); break;
      case '--max-positions':  a.maxPositions = +next(); break;
      case '--price-min':      a.priceMin = +next(); break;
      case '--price-max':      a.priceMax = +next(); break;
      case '--month-drop':     a.monthDropPct = +next(); break;
      case '--day-min':        a.dayGainMin = +next(); break;
      case '--day-max':        a.dayGainMax = +next(); break;
      case '--drop-before-bounce': a.dropIncludesToday = false; break;
      case '--per-symbol':     a.perSymbol = true; break;
      case '--help': case '-h': a.help = true; break;
      default: throw new Error(`unknown option ${argv[i]}`);
    }
  }
  return a;
}

const HELP = `
backtest/scan.mjs — run a rule across a directory of OHLCV csvs

  --dir <path>            directory of csvs, one per symbol (named SYMBOL.csv)
  --universe <file>       symbol,date,type,float — without it the common-stock
                          and float screens are NOT applied
  --strategy <name>       default bounce
  --costs <bps>           per side, split over commission and slippage
  --max-positions <n>     concurrent slots in the portfolio run (default 5)
  --per-symbol            also print a line per symbol
  --price-min/--price-max, --month-drop, --day-min/--day-max,
  --drop-before-bounce    the screen's parameters
`;

/* Pooled statistics over trades from every symbol. Sizing-free on purpose. */
export function poolTrades(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const rets = trades.map(t => t.returnPct);
  const wins = rets.filter(r => r > 0), losses = rets.filter(r => r <= 0);
  const avgWin = wins.length ? wins.reduce((s, r) => s + r, 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + r, 0) / losses.length : null;
  const winRate = wins.length / n;
  /* What the rule must clear to be worth trading: with an average win W and
     an average loss L, expectancy is zero at |L| / (W + |L|). */
  const breakeven = (avgWin != null && avgLoss != null && (avgWin - avgLoss) !== 0)
    ? -avgLoss / (avgWin - avgLoss) : null;
  const byReason = {};
  for (const t of trades) byReason[t.exitReason ?? '?'] = (byReason[t.exitReason ?? '?'] || 0) + 1;
  return {
    trades: n, winRate, avgWin, avgLoss,
    payoff: (avgWin != null && avgLoss) ? avgWin / -avgLoss : null,
    breakevenWinRate: breakeven,
    expectancy: rets.reduce((s, r) => s + r, 0) / n,
    edge: breakeven != null ? winRate - breakeven : null,
    best: Math.max(...rets), worst: Math.min(...rets),
    avgBars: trades.reduce((s, t) => s + t.bars, 0) / n,
    byReason,
  };
}

/* Equal stakes, a fixed number of slots, signals dropped when full. */
export function simulatePortfolio(trades, { initialCash = 100_000, maxPositions = 5 } = {}) {
  /* Ordering within a timestamp, as an explicit rank so the comparator is a
     total order rather than a clever pairwise rule:

       0  exits of positions opened earlier — capital freed on a day should
          be usable that same day, not a day late
       1  entries
       2  exits of positions opened on this very day

     Rank 2 exists because a bracket is live from the moment of entry, so a
     trade can open and stop out inside one bar. Lumping those in at rank 0
     runs the exit before its own entry: it finds nothing open, returns
     nothing, and the entry that follows then occupies a slot that is never
     released. Slots leak, and after enough of them every later signal is
     skipped for want of capacity — which reads as a strategy that stopped
     trading rather than as a bug. */
  const events = [];
  for (const t of trades) {
    const sameBar = t.exitTime === t.entryTime;
    events.push({ t: t.entryTime, rank: 1, kind: 'entry', trade: t });
    events.push({ t: t.exitTime, rank: sameBar ? 2 : 0, kind: 'exit', trade: t });
  }
  events.sort((a, b) => a.t - b.t || a.rank - b.rank);

  let cash = initialCash, taken = 0, skipped = 0;
  const open = new Map();                       // trade -> stake
  const curve = [{ t: events.length ? events[0].t : 0, equity: initialCash }];

  for (const e of events) {
    if (e.kind === 'entry') {
      if (open.size >= maxPositions) { skipped++; continue; }
      const equity = cash + [...open.values()].reduce((s, v) => s + v, 0);
      const stake = equity / maxPositions;
      if (stake > cash + 1e-9) { skipped++; continue; }
      cash -= stake; open.set(e.trade, stake); taken++;
    } else {
      const stake = open.get(e.trade);
      if (stake == null) continue;              // its entry was skipped
      open.delete(e.trade);
      cash += stake * (1 + e.trade.returnPct);
      curve.push({ t: e.t, equity: cash + [...open.values()].reduce((s, v) => s + v, 0) });
    }
  }
  if (open.size) {
    throw new Error(`simulatePortfolio: ${open.size} positions never closed — `
      + 'every trade must carry an exit, and its exit must sort after its entry');
  }
  const equity = curve.map(p => p.equity);
  const dd = drawdown(equity);
  const years = curve.length > 1 ? (curve[curve.length - 1].t - curve[0].t) / (365.2425 * 86400) : 0;
  const final = equity[equity.length - 1];
  return {
    taken, skipped, final, curve,
    totalReturn: final / initialCash - 1,
    cagr: years > 0 && final > 0 ? (final / initialCash) ** (1 / years) - 1 : null,
    maxDrawdown: dd.maxDrawdown,
    years,
  };
}

const pct = v => v == null ? '—' : `${(v * 100).toFixed(2)}%`;
const num = (v, d = 2) => v == null ? '—' : v.toFixed(d);

function main() {
  const a = parseArgs(process.argv);
  if (a.help || !a.dir) { console.log(HELP); process.exit(a.help ? 0 : 1); }

  const files = fs.readdirSync(a.dir).filter(f => /\.(csv|txt)$/i.test(f)).sort();
  if (!files.length) throw new Error(`no csv files in ${a.dir}`);

  const uni = a.universeFile ? parseUniverse(fs.readFileSync(a.universeFile, 'utf8')) : null;
  const opts = {
    initialCash: a.cash,
    commissionBps: a.costs != null ? a.costs / 2 : 0,
    slippageBps: a.costs != null ? a.costs / 2 : 0,
  };
  const screenOpts = {};
  for (const k of ['priceMin', 'priceMax', 'monthDropPct', 'dayGainMin', 'dayGainMax']) {
    if (a[k] != null) screenOpts[k] = a[k];
  }
  if (a.dropIncludesToday === false) screenOpts.dropIncludesToday = false;

  const all = [];
  const perSymbol = [];
  let skippedFiles = 0, totalBars = 0;

  for (const f of files) {
    const symbol = path.basename(f, path.extname(f)).toUpperCase();
    let bars;
    try { bars = loadCsv(path.join(a.dir, f)); }
    catch { skippedFiles++; continue; }
    if (a.from || a.to) bars = slice(bars, a.from, a.to);
    if (bars.length < 30) { skippedFiles++; continue; }
    totalBars += bars.length;

    const strategy = (a.strategy === 'bounce' || a.strategy === 'mine')
      ? monthlyBounce({ ...screenOpts, universe: uni ? makeScreen(uni, symbol) : null })
      : REFERENCE[a.strategy]?.();
    if (!strategy) throw new Error(`unknown strategy "${a.strategy}"`);

    const r = runBacktest(bars, strategy, opts);
    for (const t of r.trades) all.push({ ...t, symbol });
    perSymbol.push({ symbol, bars: bars.length, trades: r.trades.length,
                     metrics: computeMetrics(r) });
  }

  console.log(`\n\x1b[1mUniverse scan\x1b[0m — ${perSymbol.length} symbols, `
    + `${totalBars.toLocaleString()} bars${skippedFiles ? `, ${skippedFiles} files skipped` : ''}`);
  console.log(`costs: ${opts.commissionBps}bp + ${opts.slippageBps}bp per side`);
  if (!uni) {
    console.log('\x1b[33mno universe file — the common-stock and float screens are NOT applied\x1b[0m');
  }

  const p = poolTrades(all);
  if (!p.trades) {
    console.log('\n\x1b[33mNo trades. The screen matched nothing in this data.\x1b[0m');
    console.log('Run a single symbol through run.mjs to see which condition is binding.\n');
    return;
  }

  console.log(`\n\x1b[1mPooled trade statistics\x1b[0m  (sizing-free)`);
  const rows = [
    ['trades', p.trades],
    ['win rate', pct(p.winRate)],
    ['average win', pct(p.avgWin)],
    ['average loss', pct(p.avgLoss)],
    ['payoff ratio', num(p.payoff)],
    ['breakeven win rate', pct(p.breakevenWinRate)],
    ['edge (win rate − breakeven)', pct(p.edge)],
    ['expectancy per trade', pct(p.expectancy)],
    ['best / worst', `${pct(p.best)} / ${pct(p.worst)}`],
    ['average holding period', `${num(p.avgBars, 1)} bars`],
    ['exits', Object.entries(p.byReason).map(([k, v]) => `${k} ${v}`).join(', ')],
  ];
  for (const [k, v] of rows) console.log(`  ${String(k).padEnd(30)}${v}`);

  const verdict = p.edge == null ? null : p.edge > 0;
  if (verdict !== null) {
    console.log(verdict
      ? `\n  \x1b[32m→ positive expectancy: the win rate clears breakeven by ${pct(p.edge)}\x1b[0m`
      : `\n  \x1b[31m→ negative expectancy: the win rate is ${pct(-p.edge)} short of breakeven\x1b[0m`);
  }

  const sim = simulatePortfolio(all, { initialCash: a.cash, maxPositions: a.maxPositions });
  console.log(`\n\x1b[1mPortfolio\x1b[0m  (${a.maxPositions} slots, equal stakes)`);
  for (const [k, v] of [
    ['signals taken', sim.taken],
    ['signals skipped (no slot)', sim.skipped],
    ['final equity', `$${Math.round(sim.final).toLocaleString()}`],
    ['total return', pct(sim.totalReturn)],
    ['CAGR', pct(sim.cagr)],
    ['max drawdown (realised)', pct(sim.maxDrawdown)],
    ['span', `${num(sim.years, 1)} years`],
  ]) console.log(`  ${String(k).padEnd(30)}${v}`);
  if (sim.skipped) {
    console.log(`  \x1b[33mnote: ${pct(sim.skipped / (sim.taken + sim.skipped))} of signals were dropped for`
      + `\n        want of a slot — this rule fires in clusters.\x1b[0m`);
  }

  if (a.perSymbol) {
    console.log(`\n\x1b[1mPer symbol\x1b[0m`);
    for (const s of perSymbol.filter(s => s.trades).sort((x, y) => y.trades - x.trades)) {
      console.log(`  ${s.symbol.padEnd(8)}${String(s.trades).padStart(4)} trades  `
        + `${pct(s.metrics.totalReturn).padStart(10)}  win ${pct(s.metrics.winRate).padStart(7)}`);
    }
    const none = perSymbol.filter(s => !s.trades).length;
    if (none) console.log(`  (${none} symbols produced no trades)`);
  }
  console.log();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(`\x1b[31m${e.message}\x1b[0m`); process.exit(1); }
}
