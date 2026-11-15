// Unadjusted (as-traded) daily closes for every stock in stk-all, so price
// filters use what the price actually was that day — adjusted prices carry
// later splits backwards and make a $0.30 stock look like $300.
import fs from 'node:fs';
import path from 'node:path';
const S = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const syms = [];
for (const f of fs.readdirSync(path.join(S, 'stk-all'))) syms.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(S, 'stk-all', f), 'utf8'))));
const dir = path.join(S, 'stk-raw'); fs.mkdirSync(dir, { recursive: true });
const H = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET };
const end = new Date(Date.now() - 16 * 60e3).toISOString();
const batches = []; for (let i = 0; i < syms.length; i += 200) batches.push(syms.slice(i, i + 200));
let next = 0;
async function worker() {
  while (next < batches.length) {
    const bi = next++, file = path.join(dir, `b${bi}.json`);
    if (fs.existsSync(file)) continue;
    const base = `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(batches[bi].join(','))}&timeframe=1Day&start=2016-01-01&end=${encodeURIComponent(end)}&limit=10000&feed=sip&adjustment=raw&sort=asc`;
    const data = {}; let token = null;
    for (let page = 0; page < 5000; page++) {
      let r;
      for (let t = 0; t < 6; t++) { r = await fetch(base + (token ? `&page_token=${encodeURIComponent(token)}` : ''), { headers: H }); if (r.ok || (r.status !== 429 && r.status < 500)) break; await new Promise(res => setTimeout(res, 1500 * 2 ** t)); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      for (const [s, list] of Object.entries(j.bars || {})) for (const x of list) ((data[s] ||= { t: [], c: [] }), data[s].t.push(x.t.slice(0, 10)), data[s].c.push(+x.c.toPrecision(6)));
      token = j.next_page_token; if (!token) break;
    }
    fs.writeFileSync(file, JSON.stringify(data));
    console.log(`batch ${bi + 1}/${batches.length}`);
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log('done');
