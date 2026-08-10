# Trading Charts

Live charting for US stocks, ETFs and crypto. Alpaca market data, 41 verified
indicators, session-aware VWAP and pivots, multi-chart layouts, a scanner and a
small scripting surface.

**→ [jonahaga2.github.io/trading-charts](https://jonahaga2.github.io/trading-charts/)**

First run asks for an Alpaca API key pair. A free account is enough. Keys are
kept in your browser and sent straight to Alpaca — nothing proxies them, and
nothing is stored server-side. **Use paper keys**: anything held client-side on
a public page should never be able to move real money.

---

## Layout of the repo

`index.html` is what GitHub Pages serves: one self-contained file, no runtime
build. It is **generated** from `src/`, so edit the parts and rebuild:

```
src/ta.js       technical analysis math        ← unit-tested
src/data.js     Alpaca adapter, sessions, ticks ← tested against the live API
src/app.js      charts, indicators, panels, wiring
src/style.css   design tokens and layout
src/body.html   markup
build.mjs       concatenates the above into index.html
```

```bash
node build.mjs          # regenerate index.html
node build.mjs --check  # fail if index.html is stale
npm test                # both suites
npm run serve           # http://localhost:8099
```

`src/ta.js` and `src/data.js` are plain scripts that also export under
CommonJS, so Node can require them directly and the browser can inline them
unchanged. No bundler, no dependencies to install.

## Verifying it

Accuracy is the point of this project, so it is checked rather than asserted.

```bash
npm test
#   All 228 checks passed                          (test/ta.test.mjs)
#   All 158 checks passed against live Alpaca data (test/data.test.mjs)
```

**`test/ta.test.mjs`** attacks the math three ways: values computed by hand from
each indicator's definition, a second deliberately naive implementation of every
rolling primitive cross-checked against the fast one, and structural invariants
(bounds, warm-up positions, purity, band identities, strictly increasing
timestamps). It was mutation-tested — twenty real bugs were re-introduced one at
a time and the suite caught all twenty.

**`test/data.test.mjs`** runs against the live API and pins the candles to
ground truth established independently:

```
AAPL 2026-08-04  official open  302.73
AAPL 2026-08-07  official open  311.45   official close 313.33
```

It needs credentials — `~/trading-dashboard/.env`, or point `ALPACA_ENV` at any
file with `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY`. Only read-only market
data endpoints are called; no trading endpoint is ever touched.

`tools/shoot.mjs` drives the built page in headless Chrome, screenshots it and
reports any console error.

## Why not Yahoo

The previous version used Yahoo Finance. It was replaced because its candles
were wrong in ways no amount of correct code could fix, all measured:

- **Its intraday feed has no auction prints.** The official daily open fell
  *outside* the range of Yahoo's own 09:30 one-minute bar on five sessions in
  eight. On 2026-08-04 the open was 302.73 while the first minute only traded
  303.74–303.79 — a whole missing wick on the opening candle.
- **Intraday volume ran 11–24% under its own daily figure** for the same
  session, because the feed misses off-exchange prints.
- It rate-limits aggressively, and a hosted page could only reach it through a
  third-party CORS proxy that saw every request.

Alpaca's SIP feed reproduces the official prints, carries consolidated volume,
and allows direct browser calls.

## What the data layer gets right

Each of these was checked against real API responses, not assumed:

- **Auction prints are placed exactly.** Alpaca's *daily* bars carry the
  official open and close; its *intraday* bars do not reliably start or end on
  them. Both prints belong to known bars, so the open is written into the
  session's first bar and the close into its last, widening that bar's range to
  contain the print. The daily high and low are deliberately *not*
  redistributed — there is no way to attribute them to a bar without inventing
  one. Toggle under Settings → Data.
- **1H and 4H are rebuilt from 30-minute bars.** Alpaca's own hourly bars are
  anchored to the *clock*, so a US session's first hourly candle covers only
  09:30–10:00 and everything after is half an hour out from what every other
  platform draws. Rebuilding from each session's own open puts them back on the
  09:30 / 10:30 grid.
- **History is SIP, the last 15 minutes are IEX.** The free plan embargoes
  recent SIP data. Rather than show nothing or pretend, the tail is filled from
  IEX — genuinely real-time, but one venue — flagged `provisional`, and replaced
  by the authoritative SIP values as it ages. Settings shows how many bars are
  currently provisional.
- **Volume is consolidated.** Quotes take volume and the previous close from SIP
  daily bars, not from the IEX snapshot, which counts one venue and reports
  about 4% of the real figure (NVDA: 4.36M against 106.39M). Ranking a "most
  active" scan on that would be ranking on noise.
- **Sessions come from the exchange calendar**, so half-days are exact — the day
  after Thanksgiving closes at 13:00 and its bars filter accordingly.
- **Bars are shifted into exchange time per-instant**, so DST lands correctly. A
  fixed offset puts half the year an hour out. A useful side effect: once
  shifted, `floor(t / 86400)` *is* the trading session, which is what VWAP and
  pivots anchor to.
- **New bars only open while the market is actually trading**, so an overnight
  1-minute chart does not fill with invented flat candles.
- **Split-adjusted by default**, matching other charting platforms; dividend
  adjustment is opt-in and scales the whole candle.

## What the math gets right

`src/ta.js` follows TradingView Pine v5 semantics. The differences that matter
most against a naive implementation:

- **Wilder's indicators use RMA (α = 1/n), not EMA (α = 2/(n+1)).** RSI, ATR,
  ADX and DMI are all Wilder. These are different numbers, not a nuance.
- **Warm-up matches Pine**: `ema`/`rma` emit their first value at index n−1,
  seeded with the SMA of the first n samples.
- **`null` means "not available yet" and never silently becomes 0**, so a
  warm-up can never leak into a plotted value and a line never draws across a
  gap.
- **VWAP resets every session.** Accumulated across 60 days of 5-minute bars it
  is a number that means nothing.
- **Pivots come from the previous completed period's HLC.**
- **Ichimoku is displaced**: cloud projected `kijun` bars forward, Chikou back.
- **Supertrend's band ratchet tests the previous close**, not the current one.
- Nothing mutates its input.

Rolling primitives are O(n) rather than O(n·period), and `highest`/`lowest` use
a monotonic deque, which also avoids `Math.max(...spread)` overflowing the stack
on long windows.

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

The editor panel exposes a small explicit API over the same verified TA engine —
`close`, `open`, `high`, `low`, `volume`, `hl2`, `hlc3`, plus `sma`, `ema`,
`rma`, `wma`, `stdev`, `rsi`, `atr`, `macd`, `highest`, `lowest`, `change`, and
`plot(values, opts)` / `hline(value)`.

```js
// @name: Fast/slow cross
plot(sma(close, 10), { color: '#4B9BE8' });
plot(sma(close, 30), { color: '#E8B34A' });
```

## Limits worth knowing

- **The most recent 15 minutes are IEX, not consolidated.** On the free Alpaca
  plan SIP is embargoed for that window. IEX is real trades and genuinely
  real-time, but it is one venue, so the forming candle can differ slightly from
  a consolidated chart until it settles. Everything older than 15 minutes is
  exact. A paid Alpaca plan removes the embargo.
- **No indices.** Alpaca carries stocks, ETFs and crypto. `^GSPC` and `^VIX`
  will not load; the app suggests the ETF equivalent.
- **Intraday history is capped** by how much is practical to page: 1m ~7 days,
  5m ~35 days, 15m ~100 days, 30m ~200 days, 1H ~150 days, 4H ~300 days. Daily
  goes back ten years.
- **The lock screen is not security.** It keeps layouts separate per profile in
  one browser. Passphrases are stored as a SHA-256 hash, but the page is public
  and runs entirely client-side. Do not put anything private behind it.
- **Your API keys are in browser storage.** They go directly to Alpaca and never
  transit a proxy, which is better than the old setup, but they are still
  readable by anything with access to that browser profile. Use paper keys.
- Data is not exchange-official. This is a charting tool, not a trading system.
