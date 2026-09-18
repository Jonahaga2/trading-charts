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
import { runBacktest, buyAndHold } from './engine.mjs';
import { computeMetrics, formatMetrics, formatTable } from './metrics.mjs';
import { loadCsv, loadAlpaca, slice, describe } from './data.mjs';
import { REFERENCE, myRules } from './strategies.mjs';

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

function build(name) {
  if (name === 'mine') {
    if (!myRules) throw new Error(
      'No rules defined yet. Open backtest/strategies.mjs and replace the '
      + '`myRules` export — the template above it shows the shape.');
    return [myRules];
  }
  if (name === 'all') return Object.values(REFERENCE).map(f => f());
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

  const strategies = [...build(a.strategy), buyAndHold];
  const results = strategies.map(s => runBacktest(bars, s, opts));
  const metrics = results.map(r => computeMetrics(r));

  if (metrics.length > 2) {
    console.log(formatTable(metrics, a.sort));
  } else {
    for (const m of metrics) { console.log(`\x1b[1m${m.strategy}\x1b[0m`); console.log(formatMetrics(m)); console.log(); }
  }

  if (a.showTrades) {
    for (const r of results.filter(r => r.strategy !== 'Buy and hold')) {
      console.log(`\n\x1b[1m${r.strategy} — ${r.trades.length} trades\x1b[0m`);
      const d = t => new Date(t * 1000).toISOString().slice(0, 10);
      for (const t of r.trades.slice(0, 40)) {
        console.log(`  ${d(t.entryTime)} → ${d(t.exitTime)}  ${t.side > 0 ? 'long ' : 'short'}`
          + `  ${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)}`
          + `  ${(t.returnPct * 100).toFixed(2).padStart(7)}%  ${String(t.bars).padStart(4)} bars`
          + (t.forced ? '  (closed at end of data)' : ''));
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
