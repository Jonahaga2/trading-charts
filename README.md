# Trading Charts

Live charting for stocks, ETFs and crypto. Yahoo Finance data, 41 indicators,
session-aware VWAP and pivots, multi-chart layouts, a scanner and a small
scripting surface. No build step to deploy, no API key to use.

**→ [jonahaga2.github.io/trading-charts](https://jonahaga2.github.io/trading-charts/)**

---

## Layout of the repo

`index.html` is what GitHub Pages serves: one self-contained file, no runtime
build. It is **generated** from `src/`, so edit the parts and rebuild:

```
src/ta.js       technical analysis math       ← unit-tested
src/data.js     Yahoo adapter, sessions, ticks ← tested against the live API
src/app.js      charts, indicators, panels, wiring
src/style.css   design tokens and layout
src/body.html   markup
build.mjs       concatenates the above into index.html
```

```bash
node build.mjs          # regenerate index.html
node build.mjs --check  # fail if index.html is stale
npm test                # run both suites
npm run serve           # http://localhost:8099
```

`src/ta.js` and `src/data.js` are plain scripts that also export under
CommonJS, so Node can require them directly and the browser can inline them
unchanged. There is no bundler and no dependency to install.

## Verifying it

Accuracy is the point of this project, so it is checked rather than asserted.

```bash
npm test
#   All 228 checks passed                        (test/ta.test.mjs)
#   All 176 checks passed against live Yahoo data (test/data.test.mjs)
```

**`test/ta.test.mjs`** attacks the math three ways: values computed by hand
from each indicator's definition, a second deliberately naive implementation
of every rolling primitive cross-checked against the fast one, and structural
invariants (bounds, warm-up positions, purity, band identities, strictly
increasing timestamps). It was mutation-tested — twenty real bugs, most of
them taken from the previous version of this app, were re-introduced one at a
time and the suite caught all twenty.

**`test/data.test.mjs`** runs against live Yahoo responses and checks the
properties a chart needs to be truthful: monotonic unique stamps,
self-consistent OHLC, no synthetic bars, exchange-local timestamps across DST,
session-aligned grids, split continuity, and that 1h bars reconstruct the same
day's 1d bar. Responses are cached under `.cache/` for 30 minutes; pass
`--fresh` to re-validate against the live feed.

`tools/shoot.mjs` drives the built page in headless Chrome, screenshots it and
reports any console error:

```bash
npm run serve &
node tools/shoot.mjs clean 1500 940 tools/drivers/clean.js 11000
```

## What the data layer gets right

Each of these was checked against real API responses, not assumed:

- **Daily bars are stamped 09:30 exchange-local, not UTC midnight.** Bucketing
  live updates by UTC midnight means the daily candle never updates at all.
- **Yahoo appends a synthetic trailing bar** carrying the current price: volume
  0, `open == high == low == close`, often off the interval grid. Rendering it
  puts a fake flat candle at the right edge of every intraday chart. It is a
  live tick, so it is folded into the bar that is still forming.
- **New bars only open while the market is actually trading.** Advancing the
  bucket on wall-clock alone fills an overnight 1-minute chart with hundreds of
  invented flat candles.
- **Bars are shifted into exchange time per-instant**, so DST boundaries land
  correctly. A single fixed `gmtoffset` puts half the year an hour out. A
  useful side effect: once shifted, `floor(t / 86400)` *is* the exchange-local
  session, which is what VWAP and pivots anchor to.
- **4h uses Yahoo's native session-anchored interval.** Resampling 1h bars into
  UTC 4h buckets straddles the session open.
- **OHLC is already split-adjusted**; `adjclose` is additionally
  dividend-adjusted. Split adjustment is the default, matching other charting
  platforms; dividends are opt-in in Settings and scale the whole candle.
- `interval=1d&range=max` silently returns ~168 bars, so ranges are explicit.
- `/v7/finance/quote` returns 401 without a crumb; everything uses `/v8`.

## What the math gets right

`src/ta.js` follows TradingView Pine v5 semantics. The differences that matter
most against a naive implementation:

- **Wilder's indicators use RMA (α = 1/n), not EMA (α = 2/(n+1)).** RSI, ATR,
  ADX and DMI are all Wilder. These are different numbers, not a nuance.
- **Warm-up matches Pine**: `ema`/`rma` emit their first value at index n−1,
  seeded with the SMA of the first n samples. Seeding from `src[0]` leaves the
  first ~4n bars materially wrong.
- **`null` means "not available yet" and never silently becomes 0.** A null fed
  into a moving average yields null, so a warm-up can never leak into a plotted
  value — and a line never draws across a gap.
- **VWAP resets every session.** Accumulated across 60 days of 5-minute bars it
  is a number that means nothing.
- **Pivots come from the previous completed period's HLC**, held flat across
  the period that follows.
- **Ichimoku is displaced**: the cloud is projected `kijun` bars forward and
  Chikou plotted `kijun` bars back.
- **Supertrend's band ratchet tests the previous close**, not the current one.
- Nothing mutates its input.

Rolling primitives are O(n) rather than O(n·period), and `highest`/`lowest` use
a monotonic deque, which also avoids `Math.max(...spread)` overflowing the
stack on long windows.

## Keyboard

| key | action |
|---|---|
| `/` | symbol search |
| `1`–`6` | grid layout |
| `i` | indicators |
| `w` | watchlist |
| `f` | fit chart to data |
| `esc` | close panel / cancel drawing |

## Scripting

The editor panel exposes a small explicit API over the same verified TA engine
— `close`, `open`, `high`, `low`, `volume`, `hl2`, `hlc3`, plus `sma`, `ema`,
`rma`, `wma`, `stdev`, `rsi`, `atr`, `macd`, `highest`, `lowest`, `change`, and
`plot(values, opts)` / `hline(value)`.

```js
// @name: Fast/slow cross
plot(sma(close, 10), { color: '#4B9BE8' });
plot(sma(close, 30), { color: '#E8B34A' });
```

## Limits worth knowing

- **The lock screen is not security.** It keeps layouts separate per profile in
  one browser. Passphrases are stored as a SHA-256 hash rather than plaintext,
  but the page is public and runs entirely client-side — anyone can read the
  code and the stored layout. Do not put anything private behind it.
- **A hosted page cannot reach Yahoo directly** (no CORS header), so requests
  go through a public CORS proxy. If charts stop loading, that proxy is the
  first thing to check; `src/data.js` has a fallback chain.
- Yahoo rate-limits. The app backs off and retries; a wide scan may still be
  slow.
- Intraday history is capped by Yahoo: 1m goes back ~7 days, 5m/15m/30m ~60
  days, 1h/4h ~2 years.
- Data is delayed and is not exchange-official. This is a charting tool, not a
  trading system.
