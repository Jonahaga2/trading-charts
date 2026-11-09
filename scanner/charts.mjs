/* ═══════════════════════════════════════════════════════════════════════
   Top dip picks, with a candlestick chart image for each
   ───────────────────────────────────────────────────────────────────────
   Reads a scan (scanner/run.mjs output), picks the best five, fetches their
   full OHLC bars from Alpaca (the scan file keeps no opens, to stay small),
   draws each as an SVG candlestick chart and screenshots it to PNG with
   headless Chrome. Writes picks.json plus 1.png … 5.png. The nightly
   workflow publishes them beside scan.json, and the morning briefing links
   them.

   "Best" is deliberately simple and stated: liquid stocks ($5+, $50M+ a
   day) that fell 30%+ inside three months and have won back 20–50% of it —
   recovering, but not already recovered. Ones that crossed the 20% line on
   the latest session come first, then the deepest falls.

     ALPACA_KEY=… ALPACA_SECRET=… node scanner/charts.mjs --scan .scan/scan.json --out .scan/charts
     CHROME=/path/to/chrome  overrides the browser (default: google-chrome)
   ═══════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SCAN = require('../src/scan.js');

export const PICK = { lookback: 63, minDrop: 30, minRetrace: 20, maxRetrace: 50, minPrice: 5, minDollarVol: 5e7 };
export const SHOW = 90;                       // sessions drawn per chart

export function pickTop(rows, n = 5, opts = PICK) {
  return rows
    .map(r => ({ r, m: SCAN.evaluate(r, opts) }))
    .filter(x => x.m && x.m.pass)
    .sort((a, b) => (b.m.fresh - a.m.fresh) || (b.m.drop - a.m.drop))
    .slice(0, n);
}

/* ── Drawing ──────────────────────────────────────────────────────── */
const C = { bg: '#0B0E14', grid: '#1A2130', text: '#DFE6F1', muted: '#7C8AA5', dim: '#4C5A73',
  up: '#2EBD85', down: '#F0616D', accent: '#E8B34A' };
const W = 1000, H = 560, L = 16, R = 78, TOP = 74, PB = 410, VT = 424, VB = 508;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = x => x >= 1000 ? x.toFixed(0) : x.toFixed(2);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* bars: [{ t, o, h, l, c, v }] oldest first. m: SCAN.evaluate measurements. */
export function renderChart({ sym, name, bars, m, rank, line: back = PICK.minRetrace }) {
  const b = bars.slice(-SHOW);
  if (!b.length) throw new Error(`no bars for ${sym}`);
  let lo = Math.min(...b.map(x => x.l), m.trough), hi = Math.max(...b.map(x => x.h), m.peak);
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const vmax = Math.max(...b.map(x => x.v)) || 1;
  const step = (W - L - R) / b.length, bw = Math.max(1.5, step * 0.62);
  const X = i => L + step * (i + 0.5);
  const Y = p => TOP + (hi - p) / (hi - lo) * (PB - TOP);
  const out = [];

  // Horizontal grid and price labels, skipping any label a reference
  // line's price tag would sit on.
  const refs = [m.peak, m.trough + (m.peak - m.trough) * back / 100, m.trough].map(Y);
  for (let k = 0; k <= 4; k++) {
    const p = lo + (hi - lo) * k / 4, y = Y(p);
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${C.grid}"/>`);
    if (refs.every(ry => Math.abs(ry - y) > 16))
      out.push(`<text x="${W - R + 8}" y="${y + 4}" fill="${C.dim}" font-size="12">${fmt(p)}</text>`);
  }
  // Month labels where the month changes.
  let lastMon = -1;
  b.forEach((x, i) => {
    const d = new Date(x.t), mo = d.getUTCMonth();
    if (mo !== lastMon && i > 2) out.push(`<text x="${X(i)}" y="${H - 30}" fill="${C.dim}" font-size="12" text-anchor="middle">${MON[mo]}</text>`,
      `<line x1="${X(i)}" x2="${X(i)}" y1="${TOP}" y2="${VB}" stroke="${C.grid}" stroke-dasharray="2 4"/>`);
    lastMon = mo;
  });
  // Reference lines: the old high, the low, and the retrace line being scanned for.
  const line = (p, color, dash, label) => {
    const y = Y(p);
    out.push(`<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="1.2" stroke-dasharray="${dash}"/>`,
      `<rect x="${W - R + 2}" y="${y - 10}" width="${R - 4}" height="20" rx="3" fill="${color}"/>`,
      `<text x="${W - R + 8}" y="${y + 4}" fill="${C.bg}" font-size="12" font-weight="700">${fmt(p)}</text>`,
      `<text x="${L + 6}" y="${y - 6}" fill="${color}" font-size="12" font-weight="600" `
        + `stroke="${C.bg}" stroke-width="4" paint-order="stroke">${label}</text>`);
  };
  line(m.peak, C.muted, '6 4', 'High');
  line(m.trough + (m.peak - m.trough) * back / 100, C.accent, '2 3', `${back}% back`);
  line(m.trough, C.up, '6 4', 'Low');
  // Volume, then candles on top.
  b.forEach((x, i) => {
    const vh = (x.v / vmax) * (VB - VT), col = x.c >= x.o ? C.up : C.down;
    out.push(`<rect x="${X(i) - bw / 2}" y="${VB - vh}" width="${bw}" height="${vh}" fill="${col}" opacity=".28"/>`);
  });
  b.forEach((x, i) => {
    const col = x.c >= x.o ? C.up : C.down;
    const top = Y(Math.max(x.o, x.c)), bot = Y(Math.min(x.o, x.c));
    out.push(`<line x1="${X(i)}" x2="${X(i)}" y1="${Y(x.h)}" y2="${Y(x.l)}" stroke="${col}" stroke-width="1.2"/>`,
      `<rect class="candle" x="${X(i) - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, bot - top)}" fill="${col}"/>`);
  });
  // Header.
  const head = `<text x="${L}" y="34" fill="${C.text}" font-size="26" font-weight="750">${rank ? `#${rank}  ` : ''}${esc(sym)}</text>`
    + `<text x="${L}" y="58" fill="${C.muted}" font-size="14">${esc(name || '')}</text>`
    + `<text x="${W - 16}" y="34" fill="${C.text}" font-size="22" font-weight="700" text-anchor="end">$${fmt(m.close)}</text>`
    + `<text x="${W - 16}" y="58" font-size="14" text-anchor="end"><tspan fill="${C.down}">−${m.drop.toFixed(0)}% fall</tspan>`
    + `<tspan fill="${C.muted}">  ·  </tspan><tspan fill="${C.up}">${m.retrace.toFixed(0)}% won back</tspan>`
    + (m.fresh ? `<tspan fill="${C.accent}">  ·  NEW</tspan>` : '') + `</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" `
    + `font-family="-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`
    + `<rect width="${W}" height="${H}" fill="${C.bg}"/>${head}${out.join('')}`
    + `<text x="${W - 16}" y="${H - 10}" fill="${C.dim}" font-size="11" text-anchor="end">Daily · last ${b.length} sessions · to ${b.at(-1).t.slice(0, 10)}</text></svg>`;
}

/* ── Data ─────────────────────────────────────────────────────────── */
export async function fetchOHLC(symbols, { key, secret, fetchFn = fetch, now = Date.now() } = {}) {
  const start = new Date(now - 160 * 864e5).toISOString().slice(0, 10);
  const end = new Date(now - 16 * 60e3).toISOString();
  const base = `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(','))}`
    + `&timeframe=1Day&start=${start}&end=${encodeURIComponent(end)}&limit=10000&feed=sip&adjustment=split&sort=asc`;
  const out = {};
  let token = null;
  for (let page = 0; page < 50; page++) {
    const r = await fetchFn(base + (token ? `&page_token=${encodeURIComponent(token)}` : ''),
      { headers: { 'APCA-API-KEY-ID': key || '', 'APCA-API-SECRET-KEY': secret || '', Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Alpaca answered HTTP ${r.status}`);
    const j = await r.json();
    for (const [s, list] of Object.entries(j.bars || {})) (out[s] ||= []).push(...list);
    token = j.next_page_token;
    if (!token) break;
  }
  return out;
}

function screenshot(svgFile, pngFile) {
  const chrome = process.env.CHROME || 'google-chrome';
  execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${W},${H}`, '--force-device-scale-factor=2', `--screenshot=${pngFile}`, 'file://' + svgFile],
  { stdio: 'pipe', timeout: 60000 });
}

/* ── CLI ──────────────────────────────────────────────────────────── */
async function main() {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  const scan = JSON.parse(fs.readFileSync(a.scan || '.scan/scan.json', 'utf8'));
  const dir = path.resolve(a.out || '.scan/charts');
  fs.mkdirSync(dir, { recursive: true });

  // --retrace N / --max N override the rule's recovery range.
  const rule = { ...PICK, ...(a.retrace && { minRetrace: +a.retrace }), ...(a.max && { maxRetrace: +a.max }) };
  const top = pickTop(scan.rows, +a.n || 5, rule);
  const ohlc = top.length ? await fetchOHLC(top.map(x => x.r.s), { key: process.env.ALPACA_KEY, secret: process.env.ALPACA_SECRET }) : {};
  const picks = [];
  for (const [i, { r, m }] of top.entries()) {
    const n = i + 1;
    const svg = path.join(dir, `${n}.svg`);
    fs.writeFileSync(svg, renderChart({ sym: r.s, name: r.n, bars: ohlc[r.s] || [], m, rank: n, line: rule.minRetrace }));
    screenshot(svg, path.join(dir, `${n}.png`));
    fs.rmSync(svg);
    picks.push({ rank: n, symbol: r.s, exchange: r.x, name: r.n, close: m.close, drop: +m.drop.toFixed(1),
      retrace: +m.retrace.toFixed(1), peak: m.peak, low: m.trough, daysSinceLow: m.sinceLow, fresh: m.fresh,
      dollarVolume: m.dv, chart: `charts/${n}.png` });
  }
  fs.writeFileSync(path.join(dir, '..', 'picks.json'), JSON.stringify({ asOf: scan.asOf, rule, picks }, null, 1));
  console.error(`${picks.length} picks: ${picks.map(p => p.symbol).join(', ') || 'none'} → ${dir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
