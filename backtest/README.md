# Backtesting

A backtester for the rules you want to check, built on the indicator engine
in `archive/lightweight-engine/ta.js`.

```bash
node backtest/engine.test.mjs                                  # 56 checks, no network
node backtest/run.mjs --csv path/to/AAPL.csv --strategy all --costs 10
node backtest/run.mjs --symbol AAPL --strategy mine --from 2015-01-01
```

## The rule that the whole thing rests on

A decision made on bar *i*'s close is filled at bar *i+1*'s **open**.

You do not know a bar's close until it has closed, so filling on the same
bar means trading on information you did not have. It is the one mistake
that makes a backtester lie in the flattering direction, and it is silent —
the equity curve looks plausible, it is merely impossible. `decide()` is
handed a cursor that throws if you reach past the current bar, so the
mistake fails loudly instead of paying well.

## Writing a rule

```js
export const myRules = {
  name: 'Pullback in an uptrend',
  prepare: bars => ({
    trend: TA.ema(TA.col(bars, 'close'), 200),
    r:     TA.rsi(TA.col(bars, 'close'), 2),
  }),
  decide: (c, ctx, pos, equity) => {
    const trend = ctx.trend[c.i], r = ctx.r[c.i];
    if (trend == null || r == null) return FLAT;   // warm-up
    if (pos === FLAT && c.bar.close > trend && r < 10) return LONG;
    if (pos === LONG && r > 70) return FLAT;
    return null;                                    // hold
  },
};
```

`prepare` runs once and computes indicator arrays. `decide` runs per bar and
returns `LONG`, `SHORT`, `FLAT`, or `null` to leave the position alone.

Three things bite people:

- **Warm-up is `null`, not 0.** `null < 10` is `true` in JavaScript, so an
  unguarded comparison buys the entire warm-up period.
- **`null` is not `FLAT`.** Returning `FLAT` on every bar your entry does
  not fire exits the position the bar after it opens. Most published rules
  mean "hold until the exit fires" — that is `null`.
- **`pos` and `equity` are given to you.** Position-dependent rules and
  equity-dependent sizing need no state of your own.

## What it models, and what it does not

Modelled: next-open fills, commission and slippage in basis points per side,
long/short/flat, fractional or whole shares, forced liquidation at the end
of data so the last trade is realised rather than dangling.

Not modelled: intrabar stops and limits (a stop that would have been hit
mid-bar is not — signals are evaluated on closes), partial fills, borrow
cost and availability on shorts, market impact beyond fixed slippage,
margin and financing, dividends as cash (they are inside a back-adjusted
close instead), survivorship bias in whatever symbol list you choose.

Costs default to zero so you can see a rule on its own. A result you intend
to believe should be re-run with something real in it: 5–10bp per side
covers commission and a retail spread on liquid US equities. Anything
thinner is a claim about your broker, not about your strategy.

## Trade accounting

Trade P&L is measured equity-to-equity across the two fills, so the cost of
getting in and out sits inside each trade's number. A trade opened from flat
is booked at the equity *before* its entry transaction; a flip is one
transaction that is both an exit and an entry, so it is a single boundary
and the closing trade carries its cost. Consecutive trades therefore share a
boundary and the trade list reconciles to the account exactly — which the
test suite asserts to 1e-6 on a run with costs turned on. Booking the entry
after its own costs instead leaves those costs in the gap between trades,
belonging to nobody, and the trade list silently stops adding up.

## Metrics

Annualisation is inferred from the data's own span rather than assumed to be
252 — daily bars land near 252 after holidays, hourly bars near 1638, crypto
dailies on 365. Sortino divides by the full sample count, not the count of
losing bars, which is the standard definition; the other one inflates the
number, sometimes by a lot. Anything undefined comes back `null`, never 0: a
Sharpe of 0 means flat, a Sharpe of `null` means there was not enough
variation to compute one.

## Data

`--csv` takes any OHLCV file; column names are matched loosely. If the file
carries an `Adj Close`, OHLC is back-adjusted by `adj/close` — without that
step a 2:1 split reads as a 50% overnight crash and every momentum rule you
test will learn to trade the split. Volume is left raw, because splits and
dividends cannot be told apart from the adjusted close alone and guessing
would corrupt the volume series on ordinary dividend dates to fix a handful
of split days.

`--symbol` pulls through the adapter in `archive/lightweight-engine/data.js`
(SIP history, provisional real-time bars dropped). It needs credentials in
`APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`, or `ALPACA_ENV` pointing at a
`.env` holding them — **and** network permission for `data.alpaca.markets`,
which the sandbox this was written in does not have.

## A caution worth more than any of the above

Running seven strategies against one symbol and keeping the best is how you
end up trading noise. The reference strategies in `strategies.mjs` exist to
exercise the engine, not as recommendations. If a rule is to be believed:
hold out a period you never looked at, re-run it there, and check the result
survives realistic costs and a small change in its parameters. A rule whose
edge disappears when a 20-day lookback becomes 22 days did not have one.
