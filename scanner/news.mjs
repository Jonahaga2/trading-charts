/* Post & headline scanner: Trump's Truth Social posts, big-tech CEOs on X, and market-moving company news,
   from Google News RSS (no account or key). Prints the newest matches, de-duplicated, newest first.
     node scanner/news.mjs [--hours 18] [--json]
   Google News reports on a post within minutes to hours of it; it is not a live feed of the posts themselves. */
import { fileURLToPath } from 'node:url';

export const QUERIES = {
  'Trump posts': '(Trump "Truth Social") OR (Trump posted) OR (Trump post) tariff OR stocks OR Fed OR company',
  'Tech CEOs on X': '(Musk OR "Jensen Huang" OR Zuckerberg OR "Sam Altman" OR Nadella OR "Tim Cook" OR Bezos OR Pichai) (posted OR "on X" OR tweet OR wrote)',
  'Big tech news': '(Nvidia OR Apple OR Microsoft OR Alphabet OR Amazon OR Meta OR Tesla OR Broadcom) (shares OR stock) (announces OR unveils OR deal OR probe OR guidance)',
  'Fed & tariffs': '(Federal Reserve OR Powell OR tariff OR "trade deal") stocks',
};

const decode = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
export function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const get = t => decode((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '').trim();
    const full = get('title'), m = full.match(/^(.*) - ([^-]+)$/);
    return { title: m ? m[1].trim() : full, source: m ? m[2].trim() : get('source'), link: get('link'), time: Date.parse(get('pubDate')) || 0 };
  });
}
// Same story from many outlets → keep the newest: titles sharing 3+ words and half their words.
const words = t => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
export function dedupe(items, overlap = 0.5) {
  const kept = [];
  for (const it of items.sort((a, b) => b.time - a.time)) { const w = words(it.title);
    if (!kept.some(k => { const kw = words(k.title); let n = 0; for (const x of w) if (kw.has(x)) n++; return n >= 3 && n / Math.max(1, Math.min(w.size, kw.size)) >= overlap; })) kept.push(it); }
  return kept;
}

export async function scan({ hours = 18, perGroup = 5, fetchFn = fetch } = {}) {
  const since = Date.now() - hours * 3600e3, out = {};
  for (const [group, q] of Object.entries(QUERIES)) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:1d`)}&hl=en-US&gl=US&ceid=US:en`;
    let xml = ''; for (let t = 0; t < 3 && !xml; t++) { try { const r = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) xml = await r.text(); } catch {} }
    out[group] = dedupe(parseRss(xml).filter(x => x.time >= since)).slice(0, perGroup);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), hours = +(a[a.indexOf('--hours') + 1] || 18) || 18;
  scan({ hours }).then(r => {
    if (a.includes('--json')) return console.log(JSON.stringify(r, null, 1));
    for (const [g, items] of Object.entries(r)) { console.log(`\n## ${g}`); for (const x of items) console.log(`- ${new Date(x.time).toISOString().slice(5, 16).replace('T', ' ')}Z ${x.title} (${x.source})`); if (!items.length) console.log('- nothing new'); }
  });
}
