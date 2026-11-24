/* Checks for the post & headline scanner (no network). Run: node scanner/news.test.mjs */
import { parseRss, dedupe } from './news.mjs';
let pass = 0, fail = 0; const check = (n, c, d = '') => { if (c) pass++; else { fail++; console.log(`  ✗ ${n} ${d}`); } };
const xml = `<rss><channel><item><title>Trump says he got Nvidia to rehire Huang - CNN</title><link>https://x/1</link><pubDate>Mon, 23 Nov 2026 14:36:00 GMT</pubDate></item>
<item><title><![CDATA[Nvidia rehires Huang after Trump says he got the deal &amp; more - BBC]]></title><link>https://x/2</link><pubDate>Mon, 23 Nov 2026 15:00:00 GMT</pubDate></item>
<item><title>SEC is probing Nvidia - WSJ</title><link>https://x/3</link><pubDate>Tue, 24 Nov 2026 03:18:00 GMT</pubDate></item></channel></rss>`;
const items = parseRss(xml);
check('reads 3 items', items.length === 3);
check('splits outlet off the title', items[0].title === 'Trump says he got Nvidia to rehire Huang' && items[0].source === 'CNN', JSON.stringify(items[0]));
check('decodes CDATA and &amp;', items[1].title.includes('& more'), items[1].title);
check('reads the time', items[2].time === Date.parse('2026-11-24T03:18:00Z'));
const d = dedupe(items);
check('same story from two outlets is kept once, newest first', d.length === 2 && d[0].source === 'WSJ' && d[1].source === 'BBC', d.map(x => x.source).join());
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
