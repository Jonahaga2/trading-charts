// Daily bars (dividends and splits adjusted) for the ETFs the strategies use,
// 2016 → now, from Alpaca. Saved to etf.json.
import fs from 'node:fs';
import path from 'node:path';
const S = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const SYMS = ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'TLT', 'IEF', 'SHY', 'BIL', 'AGG', 'GLD',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC'];
const end = new Date(Date.now() - 16 * 60e3).toISOString();
const base = `https://data.alpaca.markets/v2/stocks/bars?symbols=${SYMS.join(',')}&timeframe=1Day&start=2015-01-01&end=${encodeURIComponent(end)}&limit=10000&feed=sip&adjustment=all&sort=asc`;
const out = {};
let token = null;
for (let page = 0; page < 500; page++) {
  const r = await fetch(base + (token ? `&page_token=${encodeURIComponent(token)}` : ''),
    { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + await r.text());
  const j = await r.json();
  for (const [s, list] of Object.entries(j.bars || {})) for (const x of list)
    ((out[s] ||= { t: [], o: [], c: [] }), out[s].t.push(x.t.slice(0, 10)), out[s].o.push(x.o), out[s].c.push(x.c));
  token = j.next_page_token;
  if (!token) break;
}
fs.writeFileSync(path.join(S, 'etf.json'), JSON.stringify(out));
for (const s of SYMS) console.log(s, out[s] ? `${out[s].t[0]} → ${out[s].t.at(-1)} (${out[s].t.length})` : 'MISSING');
