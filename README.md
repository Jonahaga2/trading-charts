# Trading Charts

A multi-chart workspace built on TradingView's own charts. Up to six live
charts side by side, a watchlist that drives them, symbol search, the
TradingView screener and news, saved layouts and keyboard control.

**→ [jonahaga2.github.io/trading-charts](https://jonahaga2.github.io/trading-charts/)**

No account, no API key, nothing to configure — open it and it works.

---

## What this is, and what it is not

The charts, the candles, the indicator library and the drawing tools are
**TradingView's**, shown through their embedded widget, which they serve and
license. This project does not fetch, store or redistribute any market data.

What it adds is the part their free embed does not give you: **several charts
at once**, a workspace around them, and somewhere to keep it.

## Layout of the repo

`index.html` is what GitHub Pages serves — one self-contained file, no runtime
build. It is generated from `src/`:

```
src/app.js      widget orchestration, panels, layout persistence
src/style.css   design tokens and layout
src/body.html   markup
build.mjs       concatenates the above into index.html
```

```bash
node build.mjs          # regenerate index.html
node build.mjs --check  # fail if index.html is stale  (npm test)
npm run serve           # http://localhost:8099
```

## Verifying it

`tools/cdp-shot.mjs` drives a real headless Chrome over the DevTools Protocol,
waits in **wall-clock** time and screenshots the result:

```bash
npm run serve &
node tools/cdp-shot.mjs http://localhost:8099/index.html shot.png 28000
CDP_DRIVER=driver.js node tools/cdp-shot.mjs ... # click something first
```

The wall-clock part matters. `chrome --screenshot --virtual-time-budget`
fast-forwards timers, which starves the WebSocket the widget streams its
candles over: the chrome renders and the chart stays empty. That looks exactly
like a broken build and is not one, so verification goes through CDP instead.

`tools/shoot.mjs` is the faster structural check — it reports console errors,
how many widgets mounted and what symbol, interval and theme each one was
handed, without waiting for pixels.

## Behaviour worth knowing

- **The widget is a cross-origin iframe, so nothing inside it can be read
  back.** Symbols are therefore driven from this app and a change is applied by
  rebuilding the widget. In-widget symbol changing is turned off so that the
  symbol shown is always the symbol saved.
- **Interval, indicators and drawings changed *inside* a chart belong to
  TradingView** and are not part of the saved layout. Symbols set from here
  are, along with the grid, the default interval, candle type, time zone and
  theme.
- **A grid gets leaner furniture.** With more than one chart the widget's side
  rail and date-range footer are dropped, because in a tile they take more room
  than the chart. A single chart gets everything.
- **Six charts means six TradingView apps.** They are real iframes, each
  opening its own data connection; four or six take a few seconds to settle and
  are noticeably heavier than one.

## The data

For US equities the free widget carries **Cboe One** — a single-venue feed,
roughly a tenth of consolidated volume. It matches what a free TradingView
account shows, which is the point: the charts here are the charts you are
already reading. Signing in to TradingView in the same browser applies whatever
data you are entitled to.

If you need consolidated prices with the opening and closing auction prints in
them, that is what the archived engine below was built for.

## archive/lightweight-engine

The previous version rendered its own charts. It is kept, unshipped, because it
works and because switching back is a change to `build.mjs` rather than a
rewrite:

- `ta.js` — 41 indicators, Pine-v5 semantics, Wilder RMA, session-anchored
  VWAP, displaced Ichimoku, O(n) rolling primitives.
- `data.js` — Alpaca adapter: SIP history with a real-time IEX tail, exchange
  calendar, auction reconciliation, session-aware live ticks.
- **386 checks.** 228 on the math — hand-computed goldens, an independent
  implementation of every rolling primitive, structural invariants,
  mutation-tested against 20 re-introduced bugs and catching all 20. 158
  against the live Alpaca API, pinning candles to known official auction
  prints.

```bash
npm run test:engine          # no credentials needed
npm run test:engine:data     # needs Alpaca keys
```

Why it was retired: not because it was wrong — it was measurably more accurate
than the widget, carrying consolidated volume and the real auction prints — but
because matching TradingView exactly was worth more than being right in a way
that disagreed with the chart next to it.

## Keyboard

| key | action |
|---|---|
| `/` | symbol search |
| `1`–`6` | grid layout |
| `w` | watchlist |
| `s` | screener |
| `n` | news |
| `esc` | close panel |

## Attribution

Charts, screener and news are provided by
[TradingView](https://www.tradingview.com/), used through their public
embeddable widgets. Their branding and links inside each widget are left
intact, as their terms require.
