// Quarterly net income (3-month periods, Q4 = full year − Q1..Q3), each with the date it was first filed.
// SEC fair-access: set SEC_CONTACT (an email) for the User-Agent; ≤ 9 requests a second. Needs data/liq-syms.json (stocks ever in the top 300). Writes data/sec-q.json.
import fs from 'node:fs';
import path from 'node:path';
const S = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const uaLine = `trading-charts research ${process.env.SEC_CONTACT || ''}`;
const UA = { 'User-Agent': uaLine, 'Accept-Encoding': 'gzip, deflate' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const map = await (await fetch('https://www.sec.gov/files/company_tickers.json', { headers: UA })).json();
const cikOf = new Map(Object.values(map).map(x => [x.ticker.replace('-', '.'), x.cik_str]));
const want = JSON.parse(fs.readFileSync(path.join(S, 'liq-syms.json'), 'utf8')).filter(s => cikOf.has(s));
console.log(`liquid tickers with a CIK today: ${want.length}`);
const out = {};
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
function quarters(f) {
  for (const tag of ['NetIncomeLoss', 'ProfitLoss']) {
    const u = f?.['us-gaap']?.[tag]?.units?.USD; if (!u) continue;
    const first = new Map(); // key start|end -> earliest filing
    for (const x of u) { if (!x.start || !/^10-[QK]/.test(x.form)) continue; const k = x.start + '|' + x.end; if (!first.has(k) || x.filed < first.get(k).filed) first.set(k, x); }
    const all = [...first.values()];
    const q = new Map(); for (const x of all) { const d = days(x.start, x.end); if (d > 75 && d < 105) q.set(x.end, { end: x.end, filed: x.filed, ni: x.val }); }
    for (const fy of all.filter(x => { const d = days(x.start, x.end); return d > 350 && d < 380; })) {
      if (q.has(fy.end)) continue;
      const inYear = [...q.values()].filter(z => z.end > fy.start && z.end < fy.end); if (inYear.length !== 3) continue;
      q.set(fy.end, { end: fy.end, filed: fy.filed, ni: fy.val - inYear.reduce((a, b) => a + b.ni, 0) });
    }
    return [...q.values()].sort((a, b) => a.end.localeCompare(b.end));
  }
  return [];
}
let qi = 0, n = 0, nextStart = 0;
const slot = async () => { const now = Date.now(), at = Math.max(now, nextStart); nextStart = at + 115; if (at > now) await sleep(at - now); };
async function worker() { while (qi < want.length) { const s = want[qi++]; const cik = String(cikOf.get(s)).padStart(10, '0'); let j = null;
  for (let t = 0; t < 3 && !j; t++) { await slot(); try { const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: UA }); if (r.status === 404) break; if (r.ok) j = await r.json(); else await sleep(2000 * (t + 1)); } catch { await sleep(2000); } }
  out[s] = j ? quarters(j.facts) : []; if (++n % 100 === 0) console.log(n, '/', want.length); } }
await Promise.all(Array.from({ length: 6 }, worker));
fs.writeFileSync(path.join(S, 'sec-q.json'), JSON.stringify(out));
console.log('done', Object.values(out).filter(x => x.length >= 8).length, 'with 8+ quarters');
