#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   RUN — the command line over the backtester
   ───────────────────────────────────────────────────────────────────────
     node backtest/run.mjs --csv data/AAPL.csv --strategy sma-cross
     node backtest/run.mjs --symbol AAPL --strategy mine --from 2015-01-01
     node backtest/run.mjs --csv data/AAPL.csv --strategy all --costs 10

   --symbol pulls from Alpaca and needs both credentials and network
   permission for data.alpaca.markets; --csv needs neither.

   Costs default to 0 so you can see the rule on its own, but a result you
   intend to believe should be re-run with something realistic in it. For
   liquid US equities 5–10bp per side covers commission and a retail
   spread; anything thinner than that is a claim about your broker, not
   about your strategy.
   ═══════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { runBacktest, buyAndHold } from './engine.mjs';
import { computeMetrics, formatMetrics, formatTable } from './metrics.mjs';
import { loadCsv, loadAlpaca, slice, describe } from './data.mjs';
import { REFERENCE, monthlyBounce } from './strategies.mjs';
import { loadUniverse } from './universe.mjs';

function parseArgs(argv) {
  const a = { costs: null, cash: 100_000, strategy: 'all', timeframe: '1D', sort: 'sharpe' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--csv':        a.csv = next(); break;
      case '--symbol':     a.symbol = next(); break;
      case '--timeframe':  a.timeframe = next(); break;
      case '--strategy':   a.strategy = next(); break;
      case '--from':       a.from = next(); break;
      case '--to':         a.to = next(); break;
      case '--cash':       a.cash = +next(); break;
      case '--costs':      a.costs = +next(); break;          // bps per side, split over commission+slippage
      case '--commission': a.commissionBps = +next(); break;
      case '--slippage':   a.slippageBps = +next(); break;
      case '--sort':       a.sort = next(); break;
      case '--no-short':   a.allowShort = false; break;
      case '--price-min':  a.priceMin = +next(); break;
      case '--price-max':  a.priceMax = +next(); break;
      case '--month-drop': a.monthDropPct = +next(); break;
      case '--day-min':    a.dayGainMin = +next(); break;
      case '--day-max':    a.dayGainMax = +next(); break;
      case '--drop-before-bounce': a.dropIncludesToday = false; break;
      case '--universe':   a.universe = next(); break;
      case '--whole':      a.wholeShares = true; break;
      case '--trades':     a.showTrades = true; break;
      case '--out':        a.out = next(); break;
      case '--help': case '-h': a.help = true; break;
      default: throw new Error(`unknown option ${k}`);
    }
  }
  return a;
}

const HELP = `
backtest/run.mjs — run a rule over historical bars

  Data (one of)
    --csv <file>          OHLCV csv; Adj Close is used to back-adjust if present
    --symbol <sym>        pull from Alpaca (needs credentials + network access)
    --timeframe <tf>      1D, 1H, 15Min … (with --symbol; default 1D)
    --from / --to <date>  trim the range

  Strategy
    --strategy <name>     ${Object.keys(REFERENCE).join(', ')}, mine, all
    --no-short            clamp short signals to flat

  Monthly-bounce screen (--strategy bounce | mine)
    --price-min / --price-max <n>   unadjusted price band (default 1 / 5)
    --month-drop <pct>              minimum month-to-date fall (default 10)
    --day-min / --day-max <pct>     day-gain band (default 2 / 20)
    --drop-before-bounce            test the fall through yesterday's close
    --universe <file.csv>           symbol,date,type,float — the common-stock
                                    and float screens are OFF without it

  Costs and sizing
    --costs <bps>         per side, split evenly over commission and slippage
    --commission <bps>    set separately
    --slippage <bps>      set separately
    --cash <n>            starting equity (default 100000)
    --whole               whole shares instead of fractional

  Output
    --trades              print the trade list
    --sort <metric>       rank the comparison table (default sharpe)
    --out <file.json>     write full results, equity curve included
`;

function bounceOpts(a) {
  const o = {};
  for (const k of ['priceMin', 'priceMax', 'monthDropPct', 'dayGainMin', 'dayGainMax']) {
    if (a[k] != null) o[k] = a[k];
  }
  if (a.dropIncludesToday === false) o.dropIncludesToday = false;
  if (a.universe) {
    /* One price file is one symbol, so the screen is bound to that symbol.
       With --csv the name comes from the filename. */
    const sym = a.symbol || path.basename(a.csv || '', path.extname(a.csv || ''));
    if (!sym) throw new Error('--universe needs a symbol: pass --symbol, or name the csv after it');
    o.universe = loadUniverse(a.universe, sym);
    o._screen = o.universe;
  }
  return o;
}

function build(name, a) {
  if (name === 'mine' || name === 'bounce') return [monthlyBounce(bounceOpts(a))];
  if (name === 'all') return Object.entries(REFERENCE)
    .map(([k, f]) => k === 'bounce' ? f(bounceOpts(a)) : f());
  const f = REFERENCE[name];
  if (!f) throw new Error(`unknown strategy "${name}". Known: ${Object.keys(REFERENCE).join(', ')}, mine, all`);
  return [f()];
}

async function main() {
  const a = parseArgs(process.argv);
  if (a.help || (!a.csv && !a.symbol)) { console.log(HELP); process.exit(a.help ? 0 : 1); }

  let bars = a.csv ? loadCsv(a.csv) : await loadAlpaca(a.symbol, a.timeframe);
  if (a.from || a.to) bars = slice(bars, a.from, a.to);
  if (bars.length < 3) throw new Error(`only ${bars.length} bars after filtering`);

  const opts = {
    initialCash: a.cash,
    commissionBps: a.commissionBps ?? (a.costs != null ? a.costs / 2 : 0),
    slippageBps:   a.slippageBps   ?? (a.costs != null ? a.costs / 2 : 0),
    allowShort: a.allowShort !== false,
    wholeShares: !!a.wholeShares,
  };

  const label = a.csv || `${a.symbol} ${a.timeframe}`;
  console.log(`\n\x1b[1m${label}\x1b[0m — ${describe(bars)}`);
  console.log(`costs: ${opts.commissionBps}bp commission + ${opts.slippageBps}bp slippage per side\n`);

  const strategies = [...build(a.strategy, a), buyAndHold];
  const results = strategies.map(s => runBacktest(bars, s, opts));
  const metrics = results.map(r => computeMetrics(r));

  if (metrics.length > 2) {
    console.log(formatTable(metrics, a.sort));
  } else {
    for (const m of metrics) { console.log(`\x1b[1m${m.strategy}\x1b[0m`); console.log(formatMetrics(m)); console.log(); }
  }

  /* A screen this narrow can legitimately fire zero times. Printing the
     funnel makes "no trades" a readable fact about the data rather than a
     suspicion about the code. */
  for (const r of results) {
    const st = r.ctx?.stats;
    if (!st) continue;
    console.log(`\n\x1b[1m${r.strategy} — condition funnel\x1b[0m`);
    const rows = [
      ['bars examined',            st.bars],
      ['have a prior-month close', st.hadRef],
      [`price in range`,           st.inPrice],
      [`day gain in band`,         st.dayOk],
      [`month down enough`,        st.monthOk],
      ['passed universe screen',   st.universeOk],
      ['had upside to the high',   st.targetAbove],
      ['→ entries signalled',      st.signals],
    ];
    for (const [k, v] of rows) console.log(`  ${String(k).padEnd(26)}${v}`);
    const sc = r.ctx?.screen?.stats;
    if (sc) {
      console.log(`  ${'universe: passed'.padEnd(26)}${sc.passed}`);
      console.log(`  ${'universe: wrong type'.padEnd(26)}${sc.notCommon}`);
      console.log(`  ${'universe: float too big'.padEnd(26)}${sc.tooBig}`);
      if (sc.missing) console.log(`  \x1b[33muniverse: ${sc.missing} lookups had no row on or before the bar`
        + ` and were excluded\x1b[0m`);
    }
    if (!r.params?.universeEnforced) {
      console.log('  \x1b[33mnote: no universe data supplied — the common-stock and float'
        + '\n        screens are NOT being applied.\x1b[0m');
    }
    if (st.usedAdjustedForPrice) {
      console.log('  \x1b[33mnote: bars carry no unadjusted prices, so the $ screen ran on'
        + '\n        adjusted values. Reverse splits will distort which names pass.\x1b[0m');
    }
  }

  if (a.showTrades) {
    for (const r of results.filter(r => r.strategy !== 'Buy and hold')) {
      console.log(`\n\x1b[1m${r.strategy} — ${r.trades.length} trades\x1b[0m`);
      const d = t => new Date(t * 1000).toISOString().slice(0, 10);
      for (const t of r.trades.slice(0, 40)) {
        console.log(`  ${d(t.entryTime)} → ${d(t.exitTime)}  ${t.side > 0 ? 'long ' : 'short'}`
          + `  ${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)}`
          + `  ${(t.returnPct * 100).toFixed(2).padStart(7)}%  ${String(t.bars).padStart(4)} bars`
          + `  ${t.exitReason ?? ''}`);
      }
      if (r.trades.length > 40) console.log(`  … ${r.trades.length - 40} more`);
    }
  }

  if (a.out) {
    fs.writeFileSync(a.out, JSON.stringify({
      source: label, bars: describe(bars), opts,
      results: results.map((r, i) => ({
        strategy: r.strategy, params: r.params, metrics: metrics[i],
        equity: r.equity, trades: r.trades,
        times: r.bars.map(b => b.time),
      })),
    }, null, 2));
    console.log(`\nwrote ${a.out}`);
  }
  console.log();
}

main().catch(e => { console.error(`\x1b[31m${e.message}\x1b[0m`); process.exit(1); });
