// 2016→ daily bars for every exchange-listed common stock Alpaca knows,
// active AND delisted (to avoid survivorship bias). Keeps only stocks whose
// 60-day average dollar volume ever reached $20M. Cached per batch in stk-cache/.
import fs from 'node:fs';
import path from 'node:path';
const S = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const A = JSON.parse(fs.readFileSync(path.join(S, 'assets.json'), 'utf8'));
const EXCH = new Set(['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS']);
const FUNDISH = /\b(ETF|ETN|ETNs|fund|iShares|SPDR|Vanguard|ProShares|Direxion|Invesco|WisdomTree|VanEck|Global X|leveraged|inverse|index|trust units?|warrants?|rights?|units?|preferred|depositary shares? representing|notes? due|debentures?|%)\b/i;
const active = new Set(A.active.map(a => a.symbol));
const syms = [];
for (const st of ['active', 'inactive']) for (const a of A[st]) {
  if (!EXCH.has(a.exchange) || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(a.symbol) || FUNDISH.test(a.name || '')) continue;
  if (st === 'inactive' && active.has(a.symbol)) continue;   // ticker reused by a live company: skip the old one
  syms.push(a.symbol);
}
const uniq = [...new Set(syms)];
console.log('candidates', uniq.length);
const dir = path.join(S, 'stk-all'); fs.mkdirSync(dir, { recursive: true });
const H = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET };
const end = new Date(Date.now() - 16 * 60e3).toISOString();
const batches = []; for (let i = 0; i < uniq.length; i += 200) batches.push(uniq.slice(i, i + 200));
let next = 0, done = 0, kept = 0;
async function worker() {
  while (next < batches.length) {
    const bi = next++, file = path.join(dir, `b${bi}.json`);
    if (fs.existsSync(file)) { done++; continue; }
    const base = `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(batches[bi].join(','))}&timeframe=1Day&start=2016-01-01&end=${encodeURIComponent(end)}&limit=10000&feed=sip&adjustment=all&sort=asc`;
    const data = {}; let token = null;
    for (let page = 0; page < 5000; page++) {
      let r;
      for (let t = 0; t < 6; t++) {
        r = await fetch(base + (token ? `&page_token=${encodeURIComponent(token)}` : ''), { headers: H });
        if (r.ok || (r.status !== 429 && r.status < 500)) break;
        await new Promise(res => setTimeout(res, 1500 * 2 ** t));
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      for (const [s, list] of Object.entries(j.bars || {})) for (const x of list)
        ((data[s] ||= { t: [], o: [], h: [], l: [], c: [], v: [] }), data[s].t.push(x.t.slice(0, 10)), data[s].o.push(+x.o.toPrecision(6)), data[s].h.push(+x.h.toPrecision(6)), data[s].l.push(+x.l.toPrecision(6)), data[s].c.push(+x.c.toPrecision(6)), data[s].v.push(x.v));
      token = j.next_page_token; if (!token) break;
    }
    // Keep stocks liquid enough to have mattered at some point.
    const keep = {};
    for (const [s, d] of Object.entries(data)) {
      let sum = 0, best = 0;
      for (let i = 0; i < d.c.length; i++) { sum += d.c[i] * d.v[i]; if (i >= 60) sum -= d.c[i - 60] * d.v[i - 60]; if (i >= 59) best = Math.max(best, sum / 60); }
      if (best >= 5e5) keep[s] = d;   // drop only the never-tradeable (< $0.5M a day, ever)
    }
    kept += Object.keys(keep).length;
    fs.writeFileSync(file, JSON.stringify(keep));
    console.log(`batch ${bi + 1}/${batches.length}: kept ${Object.keys(keep).length}/${Object.keys(data).length} (total ${kept})`);
    done++;
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log('done', done, 'batches');
