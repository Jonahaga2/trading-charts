# Backtest research code

The findings are in [`../RESEARCH.md`](../RESEARCH.md). This folder holds the code behind them.

## Get the data (about 700 MB, not committed)

All of these write into `research/data/`. Use Alpaca keys: free paper keys work.

```bash
export ALPACA_KEY=... ALPACA_SECRET=...
node research/etfdata.mjs        # SPY, IEF, BIL, GLD, EFA... → etf.json
node research/stockdata2.mjs     # every listed + delisted stock since 2016 → stk-all/ (needs assets.json, below)
node research/rawdata.mjs        # as-traded (unadjusted) closes → stk-raw/
export SEC_CONTACT=you@example.com   # SEC asks for a contact in the User-Agent
node research/sec.mjs            # shares, earnings, dividends as filed → sec-facts.json
node research/sic.mjs            # industry codes → sic.json
node research/secq.mjs           # quarterly net income → sec-q.json (needs liq-syms.json; run with NODE_USE_ENV_PROXY=1 behind a proxy)
```

`stockdata2.mjs` reads `assets.json`, which is Alpaca's `/v2/assets` list with
`active` and `inactive` arrays. Save it from
`https://paper-api.alpaca.markets/v2/assets?status=active` and `?status=inactive`.

## Run a test

```bash
node research/run.mjs tests/weighting.mjs
```

`run.mjs` joins `engine.mjs` with the test file into one script under `research/.build/`
and runs it with about 7 GB of memory. One run takes 1–3 minutes.

| Test | What it shows |
|---|---|
| `tests/frequency-windows.mjs` | Monthly vs weekly rebalancing, momentum windows, pool size |
| `tests/weighting.mjs` | Equal vs rank vs score weights, and the learning model |
| `tests/stops.mjs` | Stop-losses and trailing stops on the aggressive version |
| `tests/exits.mjs` | Take-profits, brackets, breakeven, moving-average exits, volatility target |
| `tests/account-brakes.mjs` | Going to cash after the account drops |
| `tests/after-hours.mjs` | Overnight / after-hours signals |
| `tests/trade-timing.mjs` | Trading at the open vs at the close |
| `tests/audit.mjs` | Data checks, look-ahead check, independent rebuild |
| `tests/audit-duplicates.mjs` | Duplicate tickers |
| `tests/live-parity.mjs` | The bot's picks vs the backtest's |

### Part 2 tests (Nov 2026): run with `ENGINE=engine2.mjs`

`engine2.mjs` adds market-adjusted momentum, industry momentum, earnings surprise (needs `sec-q.json`),
more exit types (trailing ATR, gap, time, hold buffer, stops measured from the real buy price) and
signal days shifted by 2 trading days for the "days B" robustness check. It needs about 13 GB of memory.

```bash
ENGINE=engine2.mjs node research/run.mjs tests/drawdown-bonds-gold.mjs
```

| Test | What it shows |
|---|---|
| `tests/ideas-single.mjs` | Residual momentum, crash guard, quality sleeve, industry momentum, margin, calendar |
| `tests/ideas-combos.mjs` | Earnings surprise, combinations, trading at the close, random-industry luck check |
| `tests/drawdown-1.mjs` | Where the big drops happened; low-vol mixes, swing limits |
| `tests/stop-20pct.mjs` | A 20% stop from the buy price, with cool-downs |
| `tests/stops-round2.mjs` | Trailing ATR, gap, time, hold-buffer, bubble and account-curve exits |
| `tests/stops-robustness.mjs` | Swing-skip cutoffs and trailing stops on two sets of trading days |
| `tests/drawdown-diversify.mjs` | Value, calm-and-rising, bonds, gold, risk parity, SPY hedge |
| `tests/drawdown-bonds-gold.mjs` | Momentum / low-vol / bonds / gold mixes, with and without gold's boom |
| `tests/etf-trend-and-blend.mjs` | ETF trend sleeve, blended lookbacks, leverage to a −20% drop |
| `tests/overnight-only.mjs` | Holding picks only overnight, with trading costs |
| `tests/sleeve-rotation.mjs` | Tilting between sleeves by recent returns |
| `tests/weight-search.mjs` | Short-term reversal sleeve; 2,292 weight mixes chosen on 2018–21 and checked on 2022+ |
