# Strategy research notes

Everything we built and tested, in one place. Backtests used 2018–2026 data
unless a row says otherwise. These are research notes, not financial advice.
Backtests usually look better than live trading.

---

## 1. The strategy we run: Weekly Ranked Momentum

**Rules**

1. **Stock list:** US common stocks (no ETFs) priced at **$3 or more**. Keep only the
   **300 most traded**, measured by dollar volume over the last 60 trading days.
2. **Skip "old runners":** any stock that **tripled or more in the 2 years before
   last year**.
3. **Score:** the gain from 12 months ago to 1 month ago, divided by the last year's
   volatility. Steady climbers score highest.
4. **Buy the top 10, weighted by rank:** #1 gets 10 parts, #2 gets 9, down to 1 part
   for #10. That puts about 18% in #1 and about 2% in #10.
5. **Rebalance on the first trading day of every week.** No stop-loss, no take-profit.

**Two versions**

| Version | Money in the 10 stocks | Per year | Avg month | Worst drop |
|---|---|---|---|---|
| **Aggressive (what the bot runs)** | 100% | **+51%** | +4.4% | **−45%** |
| Main plan | 50%, plus 30% SPY and 20% IEF (bonds) | +31% | +2.6% | −27% |
| SPY (for comparison) | — | +14% | +1.2% | −34% |

Both versions beat SPY in every test period: 2018–21, 2022–23 and 2024+.

---

## 2. The paper-trading bot

| Item | Detail |
|---|---|
| Code | `scanner/paper.mjs`, tests in `scanner/paper.test.mjs` |
| Account | Alpaca **paper** account only (`paper-api.alpaca.markets`), so no real money |
| Schedule | `.github/workflows/paper.yml` runs every weekday at 14:47 UTC (9:47am New York in winter). The script trades only on the first trading day of the week. |
| Manual runs | GitHub → Actions → Paper trade → Run workflow: `dry` plans only, `force` trades now |
| Keys | GitHub repository secrets `ALPACA_KEY` and `ALPACA_SECRET` (Settings → Secrets and variables → Actions) |
| Log | Every run is saved to `paper-log.json` on the `paper-log` branch: equity, picks, orders |
| Checks | On saved data, the bot picked the same 10 stocks in the same order as the backtest on each of the last 60 weekly signal days |

**First dry run (Nov 14, 2026 data):** account $742.32. Planned buys:
MRNA 18.2%, VLO 16.4%, MPC 14.5%, PSX 12.7%, SNDK 10.9%, DELL 9.1%, PBR 7.3%,
HPE 5.5%, FTNT 3.6%, ILMN 1.8%.

---

## 3. How we test (so results can be trusted)

- **Data:** daily prices from Alpaca (`adjustment=all`, so splits and dividends are
  handled the same way for every price) for every US-listed stock since 2016.
  This includes **836 stocks that were delisted or merged**, which avoids
  survivorship bias. Price filters use the price as it actually traded that day.
- **Trading:** signals use closing prices. Trades happen at the **next day's open**,
  with a 0.05% cost per trade. Delisted stocks are sold at their last price.
- **Periods:** explore 2017–21, validate 2022–23, and holdout 2024+. An idea has to work
  in all three.
- **Timing luck:** each result is the average of 4 different rebalance days, so a
  lucky date can't make an idea look good.
- **Luck controls:**
  - Random-pick portfolios ("monkeys"): 2,000 monthly and 200 weekly. The best weekly
    monkey made +25% a year. Our weekly momentum picks made +45.8%.
  - Placebo with fake signals: 20 random rankings averaged +9.8% a year, and the best
    made +15.0%. The real signal made +26.1% (the original monthly 50/30/20 plan).
  - Stale signals: a 1-month-old signal made about +16% a year, and a 12-month-old one
    about +7.5%. A real effect should fade like this as the signal gets older.
  - The plan still worked after removing its biggest winners (NVDA, AMD and others),
    and with double or higher trading costs.

---

## 4. What improved the plan (in order)

| Step | Change | Result |
|---|---|---|
| 1 | Momentum ÷ volatility, top 10 of the 300 most-traded stocks, monthly, 50/30/20 | +26.1%/yr, but about +24% averaged over rebalance days (month-end was a lucky day) |
| 2 | **Skip old runners** (idea from Ben Felix's long-term-losers point) | +23.9% → **+25.2%**, worst drop −37.5% → −35.9%. Better at every cutoff from 2× to 5×. |
| 3 | **Rebalance weekly** instead of monthly | Main plan +25.2% → **+28.3%**, worst drop −35.9% → **−27.1%**. Better in all 3 periods. |
| 4 | **Weight by rank** (10:9:…:1) instead of equal | Main plan +28.3% → **+31.3%**. 100% stocks +45.8% → **+51.3%**. Better in all 3 periods. |

---

## 5. What did NOT help (tested and rejected)

| Idea | Result vs. the plan at that time |
|---|---|
| Stocks priced $2–20 | Worse |
| Stocks under $3 | Best version +10%/yr with a −68% drop. Random picks lost about 26%/yr. |
| Mid-size stocks, or picking from the top 1,000 | Worse (+7% to +23%) |
| Industry-only momentum (chips, health, etc.) | Worse |
| EMA, volume, earnings, news, RSI filters | Worse |
| ADX trend strength above 20 or 25 (TradingLab) | About −8%/yr |
| Market trend filter (move to bonds when SPY is below its 200-day average) | Never passed all 3 periods |
| Buying the dip (several versions) | +3% to +20%/yr, all worse |
| Shorter momentum windows (3, 6, 9 months) | Worse |
| Holding 5 stocks | More return, but deeper drops (timing luck) |
| Removing "loser" traits (big jumps, wild swings, unprofitable companies…) | Every rule lowered returns. Skipping 12%+ one-day jumps was the best trade-off: −2%/yr return, about 10 points smaller drop. |
| Max picks per industry | Worse |
| International stocks in the safe part | Slightly worse |
| Gold in place of half the bonds | Looked better only because gold rose 27% in 2024 and 62% in 2025. Not adopted. |
| Learning model (ridge regression, walk-forward) | Picking with it: +16%/yr. Weighting with it: no better than rank. |
| After-hours / overnight filters | All worse. Note: our picks earn nearly all their gains overnight, about +25.9 log points overnight vs −2.3 during market hours. |
| Trading at the close instead of the open | Same-day close: about +1–2%/yr, but it assumes the bot knows the exact closing price. Next-day close: worse. |
| **Stop-losses** (3–15%, trailing, ATR) | All lowered returns. A 5% stop: +38.6% vs +51.3%. |
| **Take-profits** (10–50%, sell half, brackets) | All lower or equal |
| Breakeven lock (up 10% → protect +5%) | +53.0% vs +51.3%. One of about 30 rules tested, so probably luck. |
| Moving-average exits (10, 20, 50-day) | +22% to +28%/yr, much worse |
| Account-level brakes (go to cash after a 10–25% drop) | Much worse. They sell low and miss the rebound. |
| Cut back when swings get wild (volatility target 50%) | +46.3%/yr with a −36.7% drop: a fair trade-off, not adopted |
| 8% a month goal | Nothing came close. The best steady result averaged about 4.4% a month. |

---

## 6. Lessons from YouTube channels

- **LosingLoonies** (29 trading videos read): about 25 strategy tests, and almost all
  lost to buy-and-hold. The exception was trading Trump's tariff posts (+43.8% vs
  SPY's +28.4%, 2025–26 only, probably priced in by now).
  - Methods we adopted: random monkeys, placebo/fake signals, a sealed holdout,
    a cost knob, delay tests, a fair benchmark from the same stocks, and checking for
    look-ahead bugs (three of his "winners" were caused by look-ahead bugs).
- **Ben Felix:**
  - Stocks that rose the most over 5 years tend to lag later. This became our
    old-runner rule.
  - Betting on hot industries rarely works.
  - A few big winners drive most stock returns, which is why our take-profits hurt.
  - Equal weighting quietly works against momentum, which fits our rank-weighting result.
- **TradingLab:** mostly day-trading indicators and promotion of his own paid
  indicator. His ADX and 200-EMA filters both failed our tests. His one-month AI bot
  test is too short to mean anything.
- **Patrick Boyle:** market news and stories, nothing testable.
- **Part Time Larry:** Alpaca bot tutorials (useful for the bot), no strategy edge.

---

## 7. Data audit (Nov 2026)

| Check | Result |
|---|---|
| Prices vs. real known returns (SPY, NVDA, AAPL, META, IEF) | Match within about 1% |
| Look-ahead: picks rebuilt using only data up to each signal date | 20 of 20 identical |
| Independent rebuild of the best plan | +52.6% vs +51.3%, so the two agree |
| Volume filter used in the download | No effect: the 300th stock always traded $119M+ a day |
| Duplicate tickers (same company under two names) | 20 pairs, never both held at once |
| Two companies stitched into one ticker | 74 found. Splitting them changed nothing in the backtest. The bot now drops price history from before any 30+ day gap. |
| Odd price jumps while held | 2 of 4,270 picks, both real (NVAX, QBTS) |

---

## 8. What to expect live

- Expect **less than the backtest**. Real fills are a bit worse than the open price,
  delisted stocks may sell for less, and markets change.
- The aggressive version can **fall 45% or more**. Holding through drops is what
  makes the strategy work. Panic selling locks in the loss.
- The plan can be **concentrated in one theme**. The first dry run was about 51% oil
  and gas (VLO, MPC, PSX, PBR).
- The bot needs to **run on time**. Trading late reduces returns.

---

## 9. Ideas not tested yet

- Real after-hours bars from Alpaca minute data (would need intraday data).
- Copying Congress trades (needs paid data).
- Trump-post trading (needs post archives and minute prices; probably priced in).
- Market-on-close orders: run the bot at about 3:45pm New York. Possibly +1%/yr.

---

## 10. Where things are

| Path | What |
|---|---|
| `scanner/paper.mjs` | The paper-trading bot |
| `.github/workflows/paper.yml` | Its weekly schedule |
| `research/engine.mjs` | Backtest engine (data loading, signals, simulator, stats) |
| `research/tests/*.mjs` | Tests behind the sections above (weighting, stops, exits, after-hours, audit…) |
| `research/run.mjs` | Runs one test: `node research/run.mjs tests/weighting.mjs` |
| `research/README.md` | How to download the data and run the tests |
