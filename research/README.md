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
