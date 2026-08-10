# Trading Charts

A multi-chart workspace built on TradingView's own charts. Up to **nine** live
charts side by side, one set of controls that drives all of them, a watchlist,
symbol search, the TradingView screener and news, saved layouts and keyboard
control.

**→ [jonahaga2.github.io/trading-charts](https://jonahaga2.github.io/trading-charts/)**

No account, no API key, nothing to configure — open it and it works.

---

## What this is, and what it is not

The charts, the candles, the indicator library and the drawing tools are
**TradingView's**, shown through their embedded widget, which they serve and
license. This project does not fetch, store or redistribute any market data.

What it adds is the part their free embed does not give you: **several charts
at once**, **one control that changes all of them**, a workspace around them,
and somewhere to keep it.

## Driving nine charts from one place

Symbol and interval belong to each chart. Everything else — candle type, time
zone, theme, colours, volume, the toolbars, the legend and the indicator set —
is picked once and lands on every chart on screen. That is the only practical
way to put VWAP on nine charts, since doing it inside the widget means doing
it nine times.

Indicators live behind the **Indicators** button (`i`). TradingView publishes
no list of the study ids their embed accepts, and a wrong id fails *silently* —
the chart loads and the study simply is not there. So every id in the picker
was verified by mounting it on a live widget and reading the legend back;
`tools/study-probe.html` is how, and re-running it is how to check the list
still holds:

```bash
npm run serve
node tools/cdp-shot.mjs "http://localhost:8099/tools/study-probe.html?s=ID1,ID2,..." out.png 30000
```

Ids that were checked and drew nothing are listed in a comment beside the table
in `src/app.js`, so they do not get hopefully re-added later. Volume Profile
and Average Day Range are among them — they are paid TradingView studies and
never render in the free embed.

**Interval is per chart, and chart 1 is the master.** Each chart has its own
interval in its bar, so you can put chart 1 on 1m and leave the rest.
**Sync → Match chart 1** (`r`) then gives every chart chart 1's interval and
rebuilds them all from the settings held here. Symbols are left alone; they
have their own item in the same menu.

That rebuild is also the repair for drift. TradingView's own toolbar sits on
each chart, and an interval changed *there* happens inside a cross-origin
frame this app cannot read, so the chart quietly stops matching the others —
and the "only rebuild what changed" check cannot detect it either, because it
compares against what each chart was *built* with. Matching chart 1 rebuilds
unconditionally, which is the point.

## Colours

Settings → Appearance sets the up and down colours, the chart background and
the volume colours, on every chart at once. What is *not* there is as
deliberate as what is — this is what the free embed honours, checked against a
live widget rather than assumed:

| | |
|---|---|
| `backgroundColor` (top level) | works, on both themes |
| `mainSeriesProperties.*Style.*Color` | works |
| `studies_overrides` `volume.volume.color.1` / `.0` | works — `.1` is up, `.0` is down |
| `gridColor` (top level) | **ignored** |
| `paneProperties.background` | **ignored** — `theme` wins |
| `paneProperties.*GridProperties.color` | **ignored** |
| `scalesProperties.textColor` / `lineColor` | **ignored** |

So there is no grid or axis colour to pick: the embed will not honour them,
and a control that does nothing is worse than no control. Those ignored keys
sat in this config for months doing nothing — the charts were dark because of
`theme`, never because of the override.

Candle colours are written for `candleStyle`, `hollowCandleStyle`, `haStyle`
and `barStyle` together, because TradingView keeps a separate colour pair per
style: set only `candleStyle` and your colours vanish the moment you switch to
bars or Heikin-Ashi.

## Borderless

`f`, or the expand button. The header, the symbol bars, the hairlines between
tiles and TradingView's per-chart toolbar all go, and the browser is asked for
the screen — what is left is the charts, edge to edge. The legend stays, since
that is the reading rather than the furniture. `esc` or `f` comes back, as
does the faint pill in the corner.

It is mostly a class on `<body>`, but not entirely free: the widget toolbar
lives inside the iframe, so entering and leaving rebuilds the charts.

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

`tools/shoot.mjs` is the faster structural check — it decodes the configuration
each widget was handed out of its iframe URL and prints it, without waiting for
pixels. That is the only way to prove a setting reached all nine charts, since
nothing inside a cross-origin frame can be read back:

```bash
node tools/shoot.mjs nine 1600 1000 tools/drivers/nine-studies.js 9000
#  nine  errors:0  cells:9 iframes:9
#    widget: NASDAQ:AAPL@15/dark/1 side:1 top:0 legend:0 hidevol:0 studies[2]:VWAP…,RSI…
```

Two things to know when reading that output: **tv.js drops every false flag**,
so an absent key means *off*, not *ignored*; and it joins studies into one
string with a unit separator rather than passing an array.

`tools/override-probe.html` is the same idea for appearance: four widgets side
by side, each differing by one config key, so a key the embed ignores is
obvious at a glance. It is how the table under **Colours** was established, and
how to re-check it if TradingView changes something.

The drivers under `tools/drivers/` are the regression suite. They assert rather
than just click — `colors-sync.js` checks that a forced rebuild handed every
chart a *complete* configuration, and that guard is itself mutation-tested:
put `forEach(mountWidget)` back in `forceAll` and it must report four
failures. Its first version did not, because it checked `symbol` and
`interval`, and tv.js invents plausible values for both when handed nothing.
Check the keys the widget does **not** default.

## Behaviour worth knowing

- **The widget is a cross-origin iframe, so nothing inside it can be read
  back.** Symbols are therefore driven from this app and a change is applied by
  rebuilding the widget. In-widget symbol changing is turned off so that the
  symbol shown is always the symbol saved.
- **Interval, indicators and drawings changed *inside* a chart belong to
  TradingView** and are not part of the saved layout. Everything set from this
  app is saved: symbols, the grid, interval, candle type, time zone, theme,
  the indicator set and the toolbar switches.
- **A change to a global setting rebuilds the charts it affects.** The embed
  has no method to change anything after construction, so applying a setting
  means building a new iframe. The configuration is a pure function of state
  and is compared against what each chart was built with, so only the charts
  that actually differ are rebuilt — and rapid changes (toggling four
  indicators) coalesce into one rebuild rather than four.
- **A grid gets leaner furniture.** With more than one chart the widget's side
  rail and date-range footer are dropped, because in a tile they take more room
  than the chart. A single chart gets everything. In a dense grid the chart
  toolbar and legend are worth turning off too — both are switches in Settings.
- **Nine charts means nine TradingView apps.** They are real iframes, each
  opening its own data connection. Measured here, all nine frames load within
  ~1.3s of switching layout; the candles stream in after that, so the grid
  takes a few seconds more to fill and is noticeably heavier than one chart.

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
| `1` `2` `3` `4` `6` `9` | grid layout — the digit is the number of charts |
| `f` | borderless — just the charts |
| `i` | indicators |
| `r` | match every chart to chart 1 |
| `w` | watchlist |
| `s` | screener |
| `n` | news |
| `esc` | close panel |

## Attribution

Charts, screener and news are provided by
[TradingView](https://www.tradingview.com/), used through their public
embeddable widgets. Their branding and links inside each widget are left
intact, as their terms require.
