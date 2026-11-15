// Point-in-time fundamentals from SEC EDGAR companyfacts, for listed tickers.
// Every value keeps its `filed` date: a backtest may only use it after that day.
// SEC fair-access: a contact in the User-Agent (set SEC_CONTACT), at most 10 requests a second.
import fs from 'node:fs';
import path from 'node:path';
const S = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const UA = { 'User-Agent': `trading-charts research ${process.env.SEC_CONTACT || ''}`, 'Accept-Encoding': 'gzip, deflate' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const map = await (await fetch('https://www.sec.gov/files/company_tickers.json', { headers: UA })).json();
const cikOf = new Map(Object.values(map).map(x => [x.ticker.replace('-', '.'), x.cik_str]));
const A = JSON.parse(fs.readFileSync(path.join(S, 'assets.json'), 'utf8'));
const want = [...new Set(A.active.filter(a => ['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS'].includes(a.exchange)).map(a => a.symbol))].filter(s => cikOf.has(s));
console.log(`tickers with a CIK: ${want.length}`);
const out = fs.existsSync(path.join(S, 'sec-facts.json')) ? JSON.parse(fs.readFileSync(path.join(S, 'sec-facts.json'), 'utf8')) : {};
const firstFiled = list => {           // one value per period end: the earliest filing that reported it
  const by = new Map();
  for (const x of list) { const k = x.end; if (!by.has(k) || x.filed < by.get(k).filed) by.set(k, { end: x.end, val: x.val, filed: x.filed }); }
  return [...by.values()].sort((a, b) => a.filed.localeCompare(b.filed));
};
const annual = (facts, tags) => {
  for (const t of tags) {
    const u = facts?.['us-gaap']?.[t]?.units?.USD;
    if (u) return firstFiled(u.filter(x => x.fp === 'FY' && /^10-K/.test(x.form) && x.start && (Date.parse(x.end) - Date.parse(x.start)) > 300 * 864e5));
  }
  return [];
};
// Six workers share one clock: request starts at least 110 ms apart (≤ 9/s).
let n = 0, nextStart = 0, qi = 0;
const todo = want.filter(s => !(s in out));
const slot = async () => { const now = Date.now(), at = Math.max(now, nextStart); nextStart = at + 110; if (at > now) await sleep(at - now); };
async function worker() {
  while (qi < todo.length) {
    const s = todo[qi++];
    const cik = String(cikOf.get(s)).padStart(10, '0');
    let j = null;
    for (let t = 0; t < 3 && !j; t++) {
      await slot();
      try {
        const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: UA });
        if (r.status === 404) break;
        if (r.ok) j = await r.json(); else await sleep(2000 * (t + 1));
      } catch { await sleep(2000); }
    }
    const f = j?.facts;
    out[s] = f ? {
      shares: firstFiled(f.dei?.EntityCommonStockSharesOutstanding?.units?.shares || []),
      float: firstFiled(f.dei?.EntityPublicFloat?.units?.USD || []),
      ni: annual(f, ['NetIncomeLoss', 'ProfitLoss']),
      div: annual(f, ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends']),
    } : null;
    if (++n % 500 === 0) { fs.writeFileSync(path.join(S, 'sec-facts.json'), JSON.stringify(out)); console.log(`${n}/${todo.length}`); }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
fs.writeFileSync(path.join(S, 'sec-facts.json'), JSON.stringify(out));
const ok = Object.values(out).filter(Boolean);
console.log(`done: ${ok.length} with facts; shares ${ok.filter(x => x.shares.length).length}, float ${ok.filter(x => x.float.length).length}, net income ${ok.filter(x => x.ni.length).length}, dividends ${ok.filter(x => x.div.length).length}`);
