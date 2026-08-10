# Archived: the self-rendered charting engine

Not shipped. The live site embeds TradingView's own chart widgets, so none of
this is loaded by `index.html` any more. It is kept because it works and is
proven, and because switching back is a change to `build.mjs` rather than a
rewrite.

| file | what it is |
|---|---|
| `ta.js` | 41 indicators. Pine-v5 semantics, Wilder RMA, session-anchored VWAP, displaced Ichimoku, O(n) rolling primitives. |
| `data.js` | Alpaca adapter — SIP history with a real-time IEX tail, exchange calendar, auction reconciliation, session-aware live ticks. |
| `ta.test.mjs` | 228 checks: hand-computed goldens, an independent implementation of every rolling primitive, structural invariants. Mutation-tested against 20 re-introduced bugs; catches all 20. |
| `data.test.mjs` | 158 checks against the live Alpaca API, pinning candles to known official auction prints. Needs credentials. |

```bash
node archive/lightweight-engine/ta.test.mjs      # no credentials needed
ALPACA_ENV=path/to/.env node archive/lightweight-engine/data.test.mjs
```

The paths inside the tests resolve relative to this folder, so they run in place.
