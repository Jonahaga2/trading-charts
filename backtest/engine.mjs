/* ═══════════════════════════════════════════════════════════════════════
   ENGINE — event-driven backtester
   ───────────────────────────────────────────────────────────────────────
   One rule matters more than everything else in here:

     A decision made on bar i's CLOSE is filled at bar i+1's OPEN.

   You cannot know a bar's close until the bar has closed, so a backtester
   that decides and fills on the same bar is trading on information it did
   not have. That single mistake is what turns a losing rule into a
   beautiful equity curve, and it is silent — the numbers look plausible,
   they are simply impossible. Every fill below happens on the next bar's
   open, and `decide` is handed an accessor that cannot reach past the
   current bar at all.

   Other conventions:
     • Fractional shares. Whole-lot rounding adds noise that has nothing to
       do with whether the rule works; `wholeShares` turns it on if you
       want to model it.
     • Slippage moves the execution price against you; commission is taken
       from cash separately. Both are in basis points of notional.
     • The position is only resized when the target changes. Rebalancing to
       equity every bar would bleed costs the rule never asked for.
     • Trade P&L is measured equity-to-equity across the two fills, so the
       cost of getting in and out is inside the trade's number, not hidden
       in an aggregate somewhere.
   ═══════════════════════════════════════════════════════════════════════ */

export const LONG = 1, FLAT = 0, SHORT = -1;

/* A read-only view of history up to and including bar i. `prior(1)` is the
   previous bar. Asking for anything the strategy could not yet have seen
   throws rather than returning undefined, so a lookahead bug surfaces as a
   loud failure instead of an attractive backtest. */
function makeCursor(bars, i) {
  return {
    i,
    bar: bars[i],
    prior(k = 1) {
      if (!Number.isInteger(k) || k < 0) throw new Error(`prior(${k}): k must be a non-negative integer`);
      const j = i - k;
      return j >= 0 ? bars[j] : null;
    },
    at(j) {
      if (j > i) throw new Error(`lookahead: bar ${j} requested while deciding on bar ${i}`);
      return j >= 0 ? bars[j] : null;
    },
  };
}

export function runBacktest(bars, strategy, opts = {}) {
  const {
    initialCash   = 100_000,
    commissionBps = 0,
    slippageBps   = 0,
    sizeFrac      = 1,
    allowShort    = true,
    wholeShares   = false,
  } = opts;

  if (!Array.isArray(bars) || bars.length < 2) throw new Error('runBacktest: need at least 2 bars');
  if (!strategy || typeof strategy.decide !== 'function') throw new Error('runBacktest: strategy needs a decide()');
  if (!(sizeFrac > 0)) throw new Error('runBacktest: sizeFrac must be > 0');

  const n = bars.length;
  const ctx = strategy.prepare ? strategy.prepare(bars) : {};

  let cash = initialCash, shares = 0, target = FLAT, pending = FLAT;
  const equity = new Array(n);
  const position = new Array(n);
  const trades = [];
  let live = null;                       // the trade currently open, if any
  let fills = 0, commissionPaid = 0, slippagePaid = 0;

  const markAt = px => cash + shares * px;

  /* Move the book to `want` at bar i's open, paying to cross the spread.

     Where a trade's boundary sits decides whether the trade list adds up.
     A trade opened from flat is booked at the equity BEFORE its entry
     transaction, so it carries the cost of getting in; booking it after
     would drop that cost into the gap between two trades, where it belongs
     to nobody and the trade list quietly stops reconciling with the
     account. A flip is one transaction that is both an exit and an entry,
     so it is a single point: the closing trade carries its cost and the
     new trade starts from the same equity. Either way consecutive trades
     share a boundary and the P&L telescopes to the account exactly. */
  function fill(i, want) {
    const px = bars[i].open;
    const eqBefore = markAt(px);
    let desired = want === FLAT ? 0 : (want * eqBefore * sizeFrac) / px;
    if (wholeShares) desired = Math.trunc(desired);

    const delta = desired - shares;
    if (Math.abs(delta) * px < 1e-9) { target = want; return; }

    const dir  = Math.sign(delta);
    const exec = px * (1 + dir * slippageBps / 1e4);
    const notional = Math.abs(delta) * exec;
    const commission = notional * commissionBps / 1e4;

    cash -= delta * exec;                // buying spends cash, selling raises it
    cash -= commission;
    shares = desired;
    fills++;
    commissionPaid += commission;
    slippagePaid += Math.abs(delta) * Math.abs(exec - px);

    const eqAfter = markAt(px);
    const wasFlip = !!live && want !== live.side && want !== FLAT;

    if (live && want !== live.side) {    // closing, or flipping through zero
      live.exitIdx = i;
      live.exitTime = bars[i].time ?? i;
      live.exitPrice = exec;
      live.exitEquity = eqAfter;
      live.pnl = eqAfter - live.entryEquity;
      live.returnPct = live.entryEquity !== 0 ? live.pnl / live.entryEquity : 0;
      live.bars = i - live.entryIdx;
      trades.push(live);
      live = null;
    }
    if (want !== FLAT && !live) {
      live = {
        side: want, entryIdx: i, entryTime: bars[i].time ?? i,
        entryPrice: exec, entryEquity: wasFlip ? eqAfter : eqBefore, shares: desired,
      };
    }
    target = want;
  }

  for (let i = 0; i < n; i++) {
    if (i > 0 && pending !== target) fill(i, pending);

    equity[i] = markAt(bars[i].close);
    position[i] = target;

    const want = strategy.decide(makeCursor(bars, i), ctx, target, equity[i]);
    if (want === null || want === undefined) {
      /* hold whatever we have */
    } else if (want === LONG || want === FLAT || want === SHORT) {
      pending = (want === SHORT && !allowShort) ? FLAT : want;
    } else {
      throw new Error(`strategy.decide returned ${want}; expected 1, 0, -1 or null`);
    }
  }

  /* Close on the final bar's close so the last trade is realised and shows
     up in the trade statistics rather than dangling as an open position. */
  if (live) {
    const px = bars[n - 1].close;
    const dir = -Math.sign(shares);
    const exec = px * (1 + dir * slippageBps / 1e4);
    const commission = Math.abs(shares) * exec * commissionBps / 1e4;
    cash += shares * exec - commission;
    commissionPaid += commission;
    slippagePaid += Math.abs(shares) * Math.abs(exec - px);
    shares = 0; fills++;
    live.exitIdx = n - 1;
    live.exitTime = bars[n - 1].time ?? n - 1;
    live.exitPrice = exec;
    live.exitEquity = cash;
    live.pnl = cash - live.entryEquity;
    live.returnPct = live.entryEquity !== 0 ? live.pnl / live.entryEquity : 0;
    live.bars = n - 1 - live.entryIdx;
    live.forced = true;                  // closed by end of data, not by the rule
    trades.push(live);
    equity[n - 1] = cash;
    live = null;
  }

  return {
    strategy: strategy.name || 'unnamed',
    params: strategy.params || {},
    bars, equity, position, trades,
    initialCash, finalEquity: equity[n - 1],
    fills, commissionPaid, slippagePaid,
    opts: { initialCash, commissionBps, slippageBps, sizeFrac, allowShort, wholeShares },
  };
}

/* Buy on the first bar, hold to the last. The number every strategy has to
   beat before it is worth running. */
export const buyAndHold = {
  name: 'Buy and hold',
  decide: () => LONG,
};
