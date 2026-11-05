/* ═══════════════════════════════════════════════════════════════════════
   METRICS — what the equity curve is actually telling you
   ───────────────────────────────────────────────────────────────────────
   Total return is the least useful number here and the one everybody
   quotes. A rule that doubles your money while spending six months 60%
   underwater is not tradeable by a human, so drawdown, exposure and the
   shape of the trade distribution get equal billing.

   Conventions:
     • Annualisation infers bars-per-year from the data's own span rather
       than assuming 252. Daily US equity bars land near 252; hourly bars
       land near 1 638; crypto dailies land on 365. Guessing instead would
       quietly mis-scale every Sharpe on this page.
     • Sharpe and Sortino use per-bar simple returns of the equity curve,
       net of costs, against a configurable risk-free rate.
     • Sortino's denominator counts only returns below the target, but
       divides by the full sample count — the standard definition. Dividing
       by the count of losers instead inflates it, sometimes by a lot.
     • Anything undefined is `null`, never 0. A Sharpe of 0 means flat; a
       Sharpe of null means there was not enough variation to compute one.
   ═══════════════════════════════════════════════════════════════════════ */

const YEAR_SECS = 365.2425 * 24 * 3600;

export function barsPerYear(bars) {
  if (!bars || bars.length < 3) return 252;
  const t0 = bars[0].time, t1 = bars[bars.length - 1].time;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 252;
  const years = (t1 - t0) / YEAR_SECS;
  if (years < 1 / 52) return 252;                  // under a week — no basis to infer
  return (bars.length - 1) / years;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

function stdev(a, mu = mean(a)) {
  if (a.length < 2) return null;
  const v = a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}

/* Peak-to-trough, worst case, plus how long the account spent below its
   previous high-water mark — the part that decides whether a rule is
   survivable in practice. */
export function drawdown(equity) {
  let peak = equity[0], maxDD = 0, ddStart = 0, longest = 0, current = 0, troughIdx = 0, peakIdx = 0;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] >= peak) {
      peak = equity[i]; peakIdx = i;
      if (current > longest) longest = current;
      current = 0; ddStart = i;
    } else {
      current = i - ddStart;
      const dd = peak === 0 ? 0 : equity[i] / peak - 1;
      if (dd < -maxDD) { maxDD = -dd; troughIdx = i; }
    }
  }
  if (current > longest) longest = current;
  return { maxDrawdown: maxDD, longestDrawdownBars: longest, troughIdx, lastPeakIdx: peakIdx };
}

export function computeMetrics(result, { riskFreeRate = 0 } = {}) {
  const { equity, bars, trades, initialCash, position } = result;
  const n = equity.length;
  const ppy = barsPerYear(bars);
  const years = (n - 1) / ppy;

  const rets = [];
  for (let i = 1; i < n; i++) {
    rets.push(equity[i - 1] === 0 ? 0 : equity[i] / equity[i - 1] - 1);
  }

  const totalReturn = initialCash === 0 ? null : equity[n - 1] / initialCash - 1;
  const cagr = (years > 0 && initialCash > 0 && equity[n - 1] > 0)
    ? (equity[n - 1] / initialCash) ** (1 / years) - 1
    : null;

  const mu = rets.length ? mean(rets) : null;
  const sd = stdev(rets);
  const rfBar = riskFreeRate / ppy;

  const vol = sd == null ? null : sd * Math.sqrt(ppy);
  const sharpe = (sd == null || sd === 0) ? null : ((mu - rfBar) / sd) * Math.sqrt(ppy);

  const below = rets.map(r => Math.min(0, r - rfBar));
  const downside = rets.length > 1
    ? Math.sqrt(below.reduce((s, x) => s + x * x, 0) / (rets.length - 1))
    : null;
  const sortino = (downside == null || downside === 0) ? null : ((mu - rfBar) / downside) * Math.sqrt(ppy);

  const dd = drawdown(equity);
  const calmar = (cagr == null || dd.maxDrawdown === 0) ? null : cagr / dd.maxDrawdown;

  const exposure = position ? position.filter(p => p !== 0).length / n : null;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);

  return {
    strategy: result.strategy,
    bars: n,
    years,
    barsPerYear: ppy,
    initialCash,
    finalEquity: equity[n - 1],
    totalReturn,
    cagr,
    volatility: vol,
    sharpe,
    sortino,
    maxDrawdown: dd.maxDrawdown,
    longestDrawdownBars: dd.longestDrawdownBars,
    calmar,
    exposure,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : null) : grossWin / grossLoss,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    expectancy: trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : null,
    bestTrade: trades.length ? Math.max(...trades.map(t => t.pnl)) : null,
    worstTrade: trades.length ? Math.min(...trades.map(t => t.pnl)) : null,
    avgBarsHeld: trades.length ? mean(trades.map(t => t.bars)) : null,
    fills: result.fills,
    commissionPaid: result.commissionPaid,
    slippagePaid: result.slippagePaid,
  };
}

/* ── Presentation ─────────────────────────────────────────────────────── */

const pct = v => v == null ? '—' : `${(v * 100).toFixed(2)}%`;
const num = (v, d = 2) => v == null ? '—' : (Number.isFinite(v) ? v.toFixed(d) : '∞');
const money = v => v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function formatMetrics(m) {
  return [
    ['Final equity',    money(m.finalEquity)],
    ['Total return',    pct(m.totalReturn)],
    ['CAGR',            pct(m.cagr)],
    ['Volatility',      pct(m.volatility)],
    ['Sharpe',          num(m.sharpe)],
    ['Sortino',         num(m.sortino)],
    ['Max drawdown',    pct(m.maxDrawdown)],
    ['Longest drawdown',`${m.longestDrawdownBars} bars`],
    ['Calmar',          num(m.calmar)],
    ['Exposure',        pct(m.exposure)],
    ['Trades',          String(m.trades)],
    ['Win rate',        pct(m.winRate)],
    ['Profit factor',   num(m.profitFactor)],
    ['Expectancy',      money(m.expectancy)],
    ['Avg bars held',   num(m.avgBarsHeld, 1)],
    ['Costs paid',      money((m.commissionPaid || 0) + (m.slippagePaid || 0))],
  ].map(([k, v]) => `  ${k.padEnd(20)}${v}`).join('\n');
}

/* Side-by-side comparison, sorted by whichever column you care about. */
export function formatTable(metricsList, sortBy = 'sharpe') {
  const rows = [...metricsList].sort((a, b) => (b[sortBy] ?? -Infinity) - (a[sortBy] ?? -Infinity));
  const cols = [
    ['Strategy',  m => m.strategy,            28],
    ['CAGR',      m => pct(m.cagr),            9],
    ['Sharpe',    m => num(m.sharpe),          8],
    ['Sortino',   m => num(m.sortino),         8],
    ['MaxDD',     m => pct(m.maxDrawdown),     9],
    ['Calmar',    m => num(m.calmar),          8],
    ['Trades',    m => String(m.trades),       7],
    ['Win%',      m => pct(m.winRate),         8],
    ['PF',        m => num(m.profitFactor),    7],
    ['Expo',      m => pct(m.exposure),        8],
  ];
  const head = cols.map(([h, , w]) => h.padEnd(w)).join('');
  const rule = '─'.repeat(head.trimEnd().length);
  const body = rows.map(m => cols.map(([, f, w]) => String(f(m)).padEnd(w)).join('')).join('\n');
  return `${head}\n${rule}\n${body}`;
}
