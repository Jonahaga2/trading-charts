/* Checks for the top-picks rule and the chart renderer. No network, no browser.
   Run: node scanner/charts.test.mjs */
import { pickTop, renderChart, fetchOHLC, PICK, SHOW } from './charts.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); } };

/* Rows from closes alone (high = low = close). dv high enough to be liquid. */
const row = (s, closes, dv = 1e8) => ({ s, x: 'NYSE', n: s + ' Inc.', dv, h: [...closes], l: [...closes], c: [...closes] });
const flat = n => Array(n).fill(100);

const rows = [
  row('DEEP', [...flat(10), 30, 45]),           // fell 70%, 21% back, crossed today → fresh
  row('MID', [...flat(10), 50, 55, 62]),        // fell 50%, 24% back, crossed today → fresh
  row('OLD', [...flat(10), 40, 55, 56]),        // fell 60%, 27% back, crossed yesterday
  row('DONE', [...flat(10), 50, 90]),           // fell 50%, 80% back: already recovered, out
  row('SHALLOW', [...flat(10), 80, 90]),        // fell 20%: not a big drop, out
  row('THIN', [...flat(10), 30, 45], 1e6),      // illiquid, out
  row('PENNY', [10, 10, 10, 3, 4.5]),           // under $5, out
];
const top = pickTop(rows);
const syms = top.map(x => x.r.s).join(',');
check('keeps only liquid, deep, part-recovered drops', syms.split(',').sort().join() === 'DEEP,MID,OLD', syms);
check('fresh crossings first, deepest first within', syms === 'DEEP,MID,OLD', syms);
check('limits to n', pickTop(rows, 2).length === 2);
check('rule is 20–50% back', PICK.minRetrace === 20 && PICK.maxRetrace === 50);
check('nothing passing → empty', pickTop([row('X', flat(20))]).length === 0);

/* Renderer */
const day = i => new Date(Date.UTC(2026, 6, 1) + i * 864e5).toISOString();
const bars = Array.from({ length: 120 }, (_, i) => {
  const c = i < 100 ? 100 - i * 0.5 : 50 + (i - 100);
  return { t: day(i), o: c - 1, h: c + 2, l: c - 2, c, v: 1e6 + i };
});
const m = { close: 69, peak: 102, trough: 48, drop: 52.9, retrace: 38.9, fresh: true };
const svg = renderChart({ sym: 'TEST', name: 'Test & Co <A>', bars, m, rank: 1 });
check('draws the last SHOW sessions', (svg.match(/class="candle"/g) || []).length === SHOW);
check('names the stock, escaped', svg.includes('#1  TEST') && svg.includes('Test &amp; Co &lt;A&gt;'));
check('labels the high, low and retrace line', ['>High<', '>Low<', '>20% back<'].every(t => svg.includes(t)));
check('marks the 20% line at the right price', svg.includes(`>${(48 + 54 * 0.2).toFixed(2)}<`));
check('shows fall, recovery and NEW', svg.includes('−53% fall') && svg.includes('39% won back') && svg.includes('NEW'));
check('up and down candles coloured', svg.includes('#2EBD85') && svg.includes('#F0616D'));
check('valid-looking SVG', svg.startsWith('<svg') && svg.endsWith('</svg>'));
let threw = false;
try { renderChart({ sym: 'NONE', bars: [], m }); } catch { threw = true; }
check('no bars is an error, not a blank chart', threw);

/* Alpaca OHLC fetch: pages joined per symbol */
const pages = [
  { bars: { A: [{ t: day(0), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: 'p2' },
  { bars: { A: [{ t: day(1), o: 1.5, h: 2, l: 1, c: 1.8, v: 12 }], B: [{ t: day(1), o: 5, h: 6, l: 4, c: 5.5, v: 9 }] }, next_page_token: null },
];
let seen = [];
const fake = async (url, init) => { seen.push({ url, init }); return { ok: true, json: async () => pages[seen.length - 1] }; };
const got = await fetchOHLC(['A', 'B'], { key: 'k', secret: 's', fetchFn: fake });
check('ohlc: pages joined', got.A.length === 2 && got.B.length === 1);
check('ohlc: follows the page token', seen.length === 2 && seen[1].url.includes('page_token=p2'));
check('ohlc: sends both keys', seen[0].init.headers['APCA-API-KEY-ID'] === 'k' && seen[0].init.headers['APCA-API-SECRET-KEY'] === 's');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
