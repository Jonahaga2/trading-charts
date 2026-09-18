# Backtesting

A backtester for the rules you want to check, built on the indicator engine
in `archive/lightweight-engine/ta.js`.

```bash
node backtest/engine.test.mjs        # 56 checks on the engine and metrics
node backtest/strategy.test.mjs      # 56 on resting orders, the screen, the universe
node backtest/run.mjs --csv path/to/ABCD.csv --strategy bounce --costs 10
node backtest/run.mjs --csv path/to/ABCD.csv --strategy bounce --universe float.csv
```

Neither test suite needs network or credentials.

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

## The monthly-bounce screen

`--strategy bounce` (also exported as `myRules`) implements:

| | |
|---|---|
| entry | month-to-date return ≤ −10%, today's return between +2% and +20%, unadjusted price $1–5, common stock, float under 1bn |
| exit | limit at the monthly high, stop at the monthly low |

Both exits are resting orders, so they fill intrabar. Three choices inside
it are decisions rather than transcriptions, and each is a flag:

- **The levels are fixed at entry.** "Sell at the monthly high" is a limit
  order, and an order placed on Tuesday does not move because Thursday
  printed a higher high. A target that ratchets up with the month is a
  different rule with a different result.
- **Month-to-date is measured through today's close** (`--drop-before-bounce`
  measures through yesterday's). With the default, the stock must still be
  down 10% *after* the bounce you are buying — the stricter reading. It
  changes the trade count materially.
- **The price screen reads unadjusted prices.** Run on adjusted prices it
  selects the names that later reverse-split, which is to say the ones that
  were failing.

The structural shape of this rule, measured on four large caps over
2000–2013 with the price band removed (a mechanical check, not a result):
roughly 78% of trades stop out and 22% reach the target, winners averaging
+16% to +24% against losers at −6% to −9%. Buying after a 10% monthly fall
puts you near the month's low and far from its high, so the stop is much
the closer of the two by construction. That payoff needs a win rate around
33% to break even. Whether a $1–5 universe clears that bar is exactly the
question a real backtest has to answer, and it cannot be answered with
large-cap data.

## Universe data, and the bias that eats this strategy

"Common stocks only" and "float under 1bn" are not in a price feed. They
come from `--universe`, a point-in-time file:

```
symbol,date,type,float
ABCD,2019-01-01,CS,42000000
ABCD,2020-06-01,CS,1400000000
```

`date` is when the row became true; a lookup takes the most recent row on
or before the bar. Without the file **those two criteria are simply not
applied**, and the runner says so in yellow on every run.

Point-in-time matters more here than almost anywhere else. A stock trading
between $1 and $5 is very often a company issuing shares to stay alive, so
its float then is not its float now. Screening old bars on today's number
excludes the companies that diluted most — the ones that went on to do
worst — and returns a number the strategy could never have earned.

The larger problem no file fixes is **survivorship**. If your symbol list is
what you can download today, every company that was delisted, acquired, or
went to zero is already missing. A $1–5 universe is precisely where that
bias is largest, and it runs in the flattering direction. Build the list
from a historical snapshot including delisted names, or read the result as
an upper bound rather than an estimate.

## What it models, and what it does not

Modelled: next-open fills, commission and slippage in basis points per side,
long/short/flat, fractional or whole shares, forced liquidation at the end
of data so the last trade is realised rather than dangling.

Modelled as resting orders: limit and stop exits attached to a position,
filling intrabar at the level. A bar that gaps through fills at the open —
worse than the stop, better than the target. Where one bar touches both
levels the stop is taken first, because OHLC cannot say which came first
and assuming the good one is how a backtest flatters itself.

Not modelled: partial fills, borrow cost and availability on shorts (which
for $1–5 names is often the binding constraint), market impact beyond fixed
slippage, halts — common in exactly this universe and capable of turning a
stop into a much worse fill — margin and financing, dividends as cash (they
are inside a back-adjusted close instead), and survivorship in whatever
symbol list you choose.

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
