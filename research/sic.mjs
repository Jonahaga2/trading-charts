// Industry (SIC code) per ticker from SEC EDGAR submissions. ≤ 9 requests a second.
// SEC asks for a contact in the User-Agent: set SEC_CONTACT (an email) before running.
import fs from 'node:fs';
import path from 'node:path';
const S = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const uaLine = `trading-charts research ${process.env.SEC_CONTACT || ''}`;
const UA = { 'User-Agent': uaLine, 'Accept-Encoding': 'gzip, deflate' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const map = await (await fetch('https://www.sec.gov/files/company_tickers.json', { headers: UA })).json();
const cikOf = new Map(Object.values(map).map(x => [x.ticker.replace('-', '.'), x.cik_str]));
const syms = []; for (const f of fs.readdirSync(path.join(S, 'stk-all'))) syms.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(S, 'stk-all', f), 'utf8'))));
const file = path.join(S, 'sic.json'), out = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const todo = syms.filter(s => cikOf.has(s) && !(s in out));
console.log(`stocks ${syms.length}, with a CIK ${syms.filter(s => cikOf.has(s)).length}, to fetch ${todo.length}`);
let qi = 0, nextStart = 0, done = 0;
const slot = async () => { const now = Date.now(), at = Math.max(now, nextStart); nextStart = at + 110; if (at > now) await sleep(at - now); };
async function worker() {
  while (qi < todo.length) {
    const s = todo[qi++], cik = String(cikOf.get(s)).padStart(10, '0');
    for (let t = 0; t < 3; t++) {
      await slot();
      try { const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: UA }); if (r.ok) { const j = await r.json(); out[s] = { sic: +j.sic || 0, d: j.sicDescription || '' }; break; } if (r.status === 404) { out[s] = { sic: 0, d: '' }; break; } } catch {}
      await sleep(1000 * 2 ** t);
    }
    if (++done % 500 === 0) { fs.writeFileSync(file, JSON.stringify(out)); console.log(`${done}/${todo.length}`); }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
fs.writeFileSync(file, JSON.stringify(out)); console.log('done', Object.keys(out).length);
