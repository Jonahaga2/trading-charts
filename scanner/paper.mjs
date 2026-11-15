/* ═══════════════════════════════════════════════════════════════════════
   Paper trading: Weekly Ranked Momentum, 100% stocks ("aggressive")
   ───────────────────────────────────────────────────────────────────────
     · universe: US-listed common stocks (no ETFs), $3+, the 300 with the
       most dollar volume over the last 60 sessions
     · skip "old runners": tripled or more in the two years before the
       momentum window (long-term reversal)
     · score: 12-1 momentum ÷ volatility — the return from 12 months ago
       to 1 month ago, divided by the last year's annualised volatility
     · hold the top 10, weighted by rank: #1 gets 10 parts, #2 9 … #10 1
       (#1 ≈ 18%, #10 ≈ 2%); no SPY or bonds, no stop-loss, no take-profit
     · rebalance on the first trading session of each week

   Backtest 2018–2026 (delisted stocks included, 0.05% cost per trade):
   about +51%/yr, worst drop about −45%. Expect less live.

   Orders go to Alpaca's PAPER API only (paper-api.alpaca.markets): no real
   money. Keys come from ALPACA_KEY / ALPACA_SECRET.

     node scanner/paper.mjs              rebalance if today is the week's first session
     node scanner/paper.mjs --force      rebalance now
     node scanner/paper.mjs --dry        print the plan, place nothing
     node scanner/paper.mjs --log out/paper-log.json   append this run to a log
   ═══════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUniverse } from './run.mjs';

export const RULE = { top: 10, liquid: 300, minPrice: 3, maxRun: 2, core: {}, weighting: 'rank', minTrade: 0.005, buffer: 0.01 };

/* ── Picks (pure) ─────────────────────────────────────────────────────
   series: Map sym → { c: closes oldest→newest (dividend-adjusted), v: volumes }.
   Same arithmetic as the backtest (lab.mjs), with i = the last close. */
export function score(c, v) {
  const L = c.length - 1;
  if (L < 252) return null;
  let n = 0, s = 0, s2 = 0, dv = 0, n60 = 0;
  for (let j = L - 251; j <= L; j++) {
    const r = c[j] / c[j - 1];
    if (!(r > 0)) continue;
    if (r > 3 || r < 1 / 3) return null;           // a bad print or an unadjusted split
    const lr = Math.log(r); n++; s += lr; s2 += lr * lr;
    if (j > L - 60) { dv += c[j] * (v[j] || 0); n60++; }
  }
  if (n < 230 || n60 < 40) return null;
  const vol = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2) * 252);
  const mom = c[L - 21] / c[L - 252] - 1;
  // The two years before the momentum window: c[L−252] ÷ c[L−756] − 1 (null with under three years of history).
  const run = L >= 756 && c[L - 756] > 0 ? c[L - 252] / c[L - 756] - 1 : null;
  return { mom, vol, smooth: mom / (vol || 1), dv: dv / n60, price: c[L], run };
}

export function pickMomentum(series, rule = RULE) {
  const rows = [];
  for (const [sym, { c, v }] of series) {
    const x = score(c, v);
    if (x && x.price >= rule.minPrice && isFinite(x.smooth)) rows.push({ sym, ...x });
  }
  rows.sort((a, b) => b.dv - a.dv);
  // Old runners (tripled or more in the two years before the last one) count toward the liquid 300 but are not picked.
  return rows.slice(0, rule.liquid).filter(r => rule.maxRun == null || r.run == null || r.run < rule.maxRun)
    .sort((a, b) => b.smooth - a.smooth).slice(0, rule.top);
}

export function targetWeights(picks, rule = RULE) {
  const w = { ...rule.core };
  const stocks = 1 - Object.values(rule.core).reduce((a, b) => a + b, 0);
  // rank: best gets `top` parts, next top−1 … (picks arrive best first). Fewer picks than `top` leave the rest in cash.
  const parts = picks.map((_, n) => rule.weighting === 'rank' ? rule.top - n : 1);
  const total = parts.reduce((a, b) => a + b, 0), share = stocks * Math.min(1, picks.length / rule.top);
  picks.forEach((p, n) => { w[p.sym] = (w[p.sym] || 0) + share * parts[n] / total; });
  return w;
}

/* ── Orders (pure) ────────────────────────────────────────────────────
   positions: [{ symbol, qty, market_value }]. Returns sells (by quantity, so
   a full exit closes the position exactly) and buys (by dollar amount).
   Changes under minTrade × equity are left alone, so a month where little
   moves trades little. A buffer of cash is kept for market-order slippage. */
export function planOrders({ equity, positions, weights, rule = RULE }) {
  const have = new Map(positions.map(p => [p.symbol, p]));
  const invest = equity * (1 - rule.buffer), sells = [], buys = [];
  for (const p of positions) {
    const want = (weights[p.symbol] || 0) * invest, mv = +p.market_value, qty = +p.qty;
    if (!weights[p.symbol]) sells.push({ symbol: p.symbol, qty, all: true });
    else if (mv - want > rule.minTrade * equity && mv > 0) sells.push({ symbol: p.symbol, qty: +(qty * (mv - want) / mv).toFixed(6) });
  }
  for (const [symbol, w] of Object.entries(weights)) {
    const mv = +(have.get(symbol)?.market_value || 0), diff = w * invest - mv;
    if (diff > rule.minTrade * equity) buys.push({ symbol, notional: Math.floor(diff * 100) / 100 });
  }
  return { sells, buys };
}

/* Monday (UTC date) of the week containing `day` (YYYY-MM-DD). */
export function weekStart(day) {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/* First trading session of its week? (Monday, or Tuesday after a Monday holiday.) */
export function isFirstSessionOfWeek(today, calendar) {
  const mon = weekStart(today);
  return calendar.map(d => d.date).filter(d => d >= mon && d <= today).sort()[0] === today;
}

/* First trading session of its month? calendar: Alpaca /v2/calendar rows. */
export function isFirstSession(today, calendar) {
  const month = today.slice(0, 7);
  const first = calendar.map(d => d.date).filter(d => d.startsWith(month)).sort()[0];
  return first === today;
}

/* ── Alpaca ───────────────────────────────────────────────────────── */
const PAPER = 'https://paper-api.alpaca.markets', DATA = 'https://data.alpaca.markets';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(key, secret, fetchFn = fetch) {
  const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, Accept: 'application/json' };
  return async function call(url, { method = 'GET', body } = {}) {
    for (let t = 0; ; t++) {
      const r = await fetchFn(url, { method, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers, body: body && JSON.stringify(body) });
      if (r.ok) return r.status === 204 ? null : r.json();
      const text = (await r.text().catch(() => '')).slice(0, 300);
      if (r.status === 401 || r.status === 403) throw new Error(`Alpaca rejected the key (HTTP ${r.status}) ${text}`);
      if ((r.status === 429 || r.status >= 500) && t < 5) { await sleep(1500 * 2 ** t); continue; }
      throw new Error(`${method} ${url.replace(/\?.*/, '')}: HTTP ${r.status} ${text}`);
    }
  };
}

/* A ticker that went dark for 30+ days and came back is often a different company reusing the symbol
   (Alpaca returns both histories under one ticker). Keep only the bars after the last such gap. */
export function trimAtGap(t, c, v, maxGapDays = 30) {
  let from = 0;
  for (let i = 1; i < t.length; i++) if (Date.parse(t[i]) - Date.parse(t[i - 1]) > maxGapDays * 864e5) from = i;
  return { c: c.slice(from), v: v.slice(from) };
}

async function dailyBars(call, symbols, now = Date.now()) {
  const start = new Date(now - 1150 * 864e5)   // ~790 sessions: three years for the old-runner check.toISOString().slice(0, 10);
  const end = new Date(now - 16 * 60e3).toISOString();
  const today = new Date(now).toISOString().slice(0, 10);
  const series = new Map();
  for (let i = 0; i < symbols.length; i += 200) {
    const base = `${DATA}/v2/stocks/bars?symbols=${encodeURIComponent(symbols.slice(i, i + 200).join(','))}&timeframe=1Day`
      + `&start=${start}&end=${encodeURIComponent(end)}&limit=10000&feed=sip&adjustment=all&sort=asc`;
    let token = null;
    for (let page = 0; page < 200; page++) {
      const j = await call(base + (token ? `&page_token=${encodeURIComponent(token)}` : ''));
      for (const [s, list] of Object.entries(j.bars || {})) {
        let x = series.get(s); if (!x) series.set(s, x = { t: [], c: [], v: [] });
        // Only completed sessions: today's partial bar is not a close.
        for (const b of list) if (b.t.slice(0, 10) < today) { x.t.push(b.t.slice(0, 10)); x.c.push(b.c); x.v.push(b.v); }
      }
      token = j.next_page_token; if (!token) break;
    }
    process.stderr.write(`bars ${Math.min(i + 200, symbols.length)}/${symbols.length}\n`);
  }
  for (const [s, x] of series) series.set(s, trimAtGap(x.t, x.c, x.v));
  return series;
}

async function getText(url) {
  for (let t = 0; t < 4; t++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) return await r.text(); } catch {}
    await sleep(1000 * 2 ** t);
  }
  throw new Error('could not fetch ' + url);
}

async function waitFilled(call, ids, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const open = (await Promise.all(ids.map(id => call(`${PAPER}/v2/orders/${id}`)))).filter(o => !['filled', 'canceled', 'rejected', 'expired'].includes(o.status));
    if (!open.length) return true;
    await sleep(3000);
  }
  return false;
}

async function main() {
  const a = Object.fromEntries(process.argv.slice(2).map((x, i, all) => x.startsWith('--') ? [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
  const key = process.env.ALPACA_KEY, secret = process.env.ALPACA_SECRET;
  if (!key || !secret) { console.error('ALPACA_KEY / ALPACA_SECRET are not set'); process.exit(2); }
  const call = client(key, secret);

  const clock = await call(`${PAPER}/v2/clock`);
  const today = clock.timestamp.slice(0, 10);
  const cal = await call(`${PAPER}/v2/calendar?start=${weekStart(today)}&end=${today}`);
  if (!a.force && !a.dry && !isFirstSessionOfWeek(today, cal)) { console.log(`${today}: not the week's first session — nothing to do`); return; }

  // Universe: listed common stocks (no ETFs) that Alpaca can trade.
  const DIR = 'https://www.nasdaqtrader.com/dynamic/SymDir/';
  const [nq, other] = await Promise.all([getText(DIR + 'nasdaqlisted.txt'), getText(DIR + 'otherlisted.txt')]);
  const assets = await call(`${PAPER}/v2/assets?status=active&asset_class=us_equity`);
  const tradable = new Map(assets.filter(x => x.tradable).map(x => [x.symbol, x]));
  const universe = parseUniverse(nq, other).map(u => u.s).filter(s => tradable.has(s));
  console.error(`universe: ${universe.length} stocks`);

  const series = await dailyBars(call, universe);
  const picks = pickMomentum(series);
  const weights = targetWeights(picks);
  const acct = await call(`${PAPER}/v2/account`);
  const positions = await call(`${PAPER}/v2/positions`);
  const equity = +acct.equity;
  console.log(`${today} · equity $${equity.toFixed(2)} · market ${clock.is_open ? 'open' : 'closed'}`);
  console.log('picks: ' + picks.map(p => `${p.sym} ${(weights[p.sym] * 100).toFixed(1)}% (${(p.mom * 100).toFixed(0)}% 12-1, vol ${(p.vol * 100).toFixed(0)}%)`).join(', '));

  const { sells, buys } = planOrders({ equity, positions, weights });
  // A stock Alpaca cannot trade in fractions is bought in whole shares.
  for (const b of buys) {
    const asset = tradable.get(b.symbol) || assets.find(x => x.symbol === b.symbol);
    if (asset && !asset.fractionable) { const px = series.get(b.symbol)?.c.at(-1); b.qty = px ? Math.floor(b.notional / px) : 0; delete b.notional; }
  }
  for (const s of sells) console.log(`  sell ${s.all ? 'all' : s.qty} ${s.symbol}`);
  for (const b of buys) console.log(`  buy ${b.notional != null ? '$' + b.notional : b.qty + ' sh'} ${b.symbol}`);

  const placed = [];
  if (!a.dry) {
    const ids = [];
    for (const s of sells) {
      const o = s.all ? await call(`${PAPER}/v2/positions/${encodeURIComponent(s.symbol)}`, { method: 'DELETE' })
        : await call(`${PAPER}/v2/orders`, { method: 'POST', body: { symbol: s.symbol, qty: String(s.qty), side: 'sell', type: 'market', time_in_force: 'day' } });
      ids.push(o.id); placed.push({ side: 'sell', symbol: s.symbol, qty: s.all ? 'all' : s.qty });
    }
    // Sell first so the buys are paid for; while the market is closed the
    // orders queue for the open instead.
    if (ids.length && clock.is_open) await waitFilled(call, ids);
    for (const b of buys) {
      if (b.qty === 0) continue;
      const body = { symbol: b.symbol, side: 'buy', type: 'market', time_in_force: 'day', ...(b.notional != null ? { notional: b.notional.toFixed(2) } : { qty: String(b.qty) }) };
      try { await call(`${PAPER}/v2/orders`, { method: 'POST', body }); placed.push({ side: 'buy', symbol: b.symbol, ...(b.notional != null ? { notional: b.notional } : { qty: b.qty }) }); }
      catch (e) { console.error(`  ✗ ${b.symbol}: ${e.message}`); }
    }
    console.log(`placed ${placed.length} orders`);
  }

  if (a.log) {
    const spy = series.get('SPY')?.c.at(-1) ?? (await call(`${DATA}/v2/stocks/SPY/trades/latest?feed=sip`)).trade?.p;
    const log = fs.existsSync(a.log) ? JSON.parse(fs.readFileSync(a.log, 'utf8')) : { started: today, runs: [] };
    log.runs.push({ date: today, equity, spy, dry: !!a.dry, picks: picks.map(p => p.sym), orders: placed });
    fs.writeFileSync(a.log, JSON.stringify(log, null, 1));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
