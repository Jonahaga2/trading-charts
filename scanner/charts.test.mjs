/* Checks for the top-picks rule and the chart renderer. No network, no browser.
   Run: node scanner/charts.test.mjs */
import { pickTop, renderChart, fetchOHLC, toHourly, nyTime, PICK, SHOW, SHOW_HOURS } from './charts.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); } };

/* Rows from closes alone (high = low = close). dv high enough to be liquid. */
const row = (s, closes, dv = 1e8) => ({ s, x: 'NYSE', n: s + ' Inc.', dv, h: [...closes], l: [...closes], c: [...closes] });
const flat = n => Array(n).fill(100);

const R20 = { ...PICK, minRetrace: 20, maxRetrace: 50 };   // the fixtures below are sized for 20–50%
const rows = [
  row('DEEP', [...flat(10), 30, 32.5, 35, 37.5, 40, 42.5, 45]), // fell 70%, 21% back, crossed today, ≤8%/day
  row('MID', [...flat(10), 50, 54, 58, 62]),    // fell 50%, 24% back, crossed today
  row('OLD', [...flat(10), 40, 43, 46, 49, 52, 53]), // fell 60%, 22% back, crossed yesterday
  row('DONE', [...flat(10), 50, 90]),           // fell 50%, 80% back: already recovered, out
  row('SHALLOW', [...flat(10), 80, 90]),        // fell 20%: not a big drop, out
  row('THIN', [...flat(10), 30, 45], 1e6),      // illiquid, out
  row('PENNY', [10, 10, 10, 3, 4.5]),           // under $5, out
];
const top = pickTop(rows, 5, R20);
const syms = top.map(x => x.r.s).join(',');
check('keeps only liquid, deep, part-recovered drops', syms.split(',').sort().join() === 'DEEP,MID,OLD', syms);
check('fresh crossings first, deepest first within', syms === 'DEEP,MID,OLD', syms);
check('limits to n', pickTop(rows, 2, R20).length === 2);
check('default rule is 50–85% back', PICK.minRetrace === 50 && PICK.maxRetrace === 85);
check('rule caps a one-day jump at 10%', PICK.maxJump === 10);
const spiky = row('SPIKE', [...flat(10), 50, 51, 65]);   // fell 50%, +27% in a day
const calm = row('CALM', [...flat(10), 50, 54, 58, 62]); // fell 50%, ≤8% a day
const picked = pickTop([spiky, calm], 5, R20).map(x => x.r.s).join();
check('a one-day spike is not picked, a steady climb is', picked === 'CALM', picked);
check('nothing passing → empty', pickTop([row('X', flat(20))]).length === 0);
check('default rule applies with no override', pickTop(rows).length === 0);

/* Renderer */
const day = i => new Date(Date.UTC(2026, 6, 1) + i * 864e5).toISOString();
const bars = Array.from({ length: 120 }, (_, i) => {
  const c = i < 100 ? 100 - i * 0.5 : 50 + (i - 100);
  return { t: day(i), o: c - 1, h: c + 2, l: c - 2, c, v: 1e6 + i };
});
const m = { close: 69, peak: 102, trough: 48, drop: 52.9, retrace: 38.9, fresh: true };
const svg = renderChart({ sym: 'TEST', name: 'Test & Co <A>', bars, m, rank: 1, line: 20 });
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

/* Hourly candles from 30-minute bars, on the 9:30 grid, regular hours only */
{
  // Fri 2026-11-06 is EST (UTC−5): 9:30 ET = 14:30Z. A full day of 30-min
  // bars from 8:30 to 18:00 ET (bar 2 is 9:30), each bar's close = its index, so the
  // grouping is visible in the output.
  const day30 = (date, utcOpenHour) => Array.from({ length: 20 }, (_, i) => {
    const t = new Date(Date.UTC(...date, utcOpenHour - 1, 30 + i * 30)).toISOString();   // from 8:30 ET
    return { t, o: i, h: i + 0.5, l: i - 0.5, c: i, v: 10 };
  });
  const fri = toHourly(day30([2026, 10, 6], 14));
  check('hourly: 7 candles in a regular session', fri.length === 7, String(fri.length));
  check('hourly: first candle opens at 9:30 ET', nyTime(fri[0].t).min === 570 && fri[0].day === '2026-11-06');
  check('hourly: pre-market dropped (opens on the 9:30 bar)', fri[0].o === 2);
  check('hourly: two 30-min bars merged', fri[0].c === 3 && fri[0].h === 3.5 && fri[0].l === 1.5 && fri[0].v === 20);
  check('hourly: last candle is 15:30 only, half an hour', nyTime(fri[6].t).min === 930 && fri[6].v === 10 && fri[6].c === 14);
  check('hourly: after-hours dropped', fri.every(x => x.c <= 14));
  // Wed 2026-07-01 is EDT (UTC−4): 9:30 ET = 13:30Z.
  const jul = toHourly(day30([2026, 6, 1], 13));
  check('hourly: daylight saving handled', jul.length === 7 && nyTime(jul[0].t).min === 570 && jul[0].o === 2);
  check('hourly: sessions kept apart', toHourly([...day30([2026, 6, 1], 13), ...day30([2026, 10, 6], 14)]).length === 14);
}

/* Hourly chart */
{
  const hb = toHourly(Array.from({ length: 30 }, (_, d) => Array.from({ length: 13 }, (_, k) => {
    const c = 60 + Math.sin(d + k / 13) * 5;
    return { t: new Date(Date.UTC(2026, 9, 1 + d, 14, 30 + k * 30)).toISOString(), o: c - 0.3, h: c + 1, l: c - 1, c, v: 1e5 };
  })).flat());
  const hs = renderChart({ sym: 'HR', bars: hb, m: { ...m, peak: 70, trough: 50, close: 60 }, tf: 'hour', line: 50 });
  check('hourly chart: draws SHOW_HOURS candles', (hs.match(/class="candle"/g) || []).length === SHOW_HOURS);
  check('hourly chart: says so', hs.includes('1-hour candles, regular hours'));
  check('hourly chart: dated session labels', /> ?(Oct|Nov) \d{1,2}</.test(hs));
}

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
