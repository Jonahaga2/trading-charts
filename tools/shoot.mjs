/* Headless screenshot + console-error harness.
   Wraps index.html with an error collector and an optional driver snippet,
   so a screenshot run also reports whether anything threw.
   Usage: node tools/shoot.mjs <name> <width> <height> <driverFile|-> <settleMs> */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [name, w, h, driverFile, settle] = process.argv.slice(2);
const OUT = process.env.SHOT_DIR || path.join(ROOT, '.shots');
fs.mkdirSync(OUT, { recursive: true });

const driver = driverFile && driverFile !== '-' ? fs.readFileSync(path.join(ROOT, driverFile), 'utf8') : '';
const settleMs = Number(settle) || 9000;

// Optional credential seeding for end-to-end runs. Read from the environment
// so keys never land in a file — __probe.html is gitignored regardless.
const seed = (process.env.SHOT_ALPACA_KEY && process.env.SHOT_ALPACA_SECRET)
  ? `try{localStorage.setItem('tc:alpaca',JSON.stringify({key:${JSON.stringify(process.env.SHOT_ALPACA_KEY)},secret:${JSON.stringify(process.env.SHOT_ALPACA_SECRET)},paper:true}))}catch(e){}`
  : '';

const probe = `<script>
window.__err=[];
addEventListener('error',e=>window.__err.push('ERROR: '+(e.message||e.error)+' @'+e.lineno));
addEventListener('unhandledrejection',e=>window.__err.push('REJECT: '+(e.reason&&e.reason.message||e.reason)));
const _ce=console.error;console.error=(...a)=>{window.__err.push('CONSOLE: '+a.map(String).join(' '));_ce(...a)};
try{localStorage.clear()}catch(e){}
${seed}
const ev=t=>{if(t)t.dispatchEvent(new MouseEvent('click',{bubbles:true}))};
// Pick an indicator by its visible name in the Indicators panel.
const pickInd=n=>{const it=[...document.querySelectorAll('#studies-body .row')].find(x=>x.querySelector('.row-sym').textContent.trim()===n);
  if(it)ev(it); else window.__err.push('MISSING INDICATOR: '+n)};
addEventListener('load',()=>setTimeout(()=>{
${driver}
  setTimeout(()=>{
    const o=document.createElement('pre');
    o.id='RESULT'+'BLOCK';
    o.style.cssText='position:fixed;left:-9999px';
    o.textContent=btoa(unescape(encodeURIComponent(JSON.stringify({
      errors:window.__err,
      bodyW:document.documentElement.scrollWidth, winW:innerWidth,
      cells:document.querySelectorAll('.cell').length,
      iframes:document.querySelectorAll('.chart-mount iframe').length,
      symbols:[...document.querySelectorAll('.sym-input')].map(x=>x.value),
      // The widget encodes its configuration into the iframe fragment, so this
      // is the one place the parent can prove what each chart was handed —
      // nothing inside the cross-origin frame can be read back. Note tv.js
      // omits every false flag and joins studies with a unit separator, so an
      // absent key means "off", not "ignored".
      srcs:[...document.querySelectorAll('.chart-mount iframe')].map(f=>{
        try{const j=JSON.parse(decodeURIComponent(f.src.split('#')[1]||''));
          const s=String(j.studies||'').split('\\u001f').filter(Boolean);
          return j.symbol+'@'+j.interval+'/'+j.theme+'/'+j.style
            +' side:'+(j.hide_side_toolbar||'0')+' top:'+(j.hide_top_toolbar||'0')
            +' legend:'+(j.hide_legend||'0')+' hidevol:'+(j.hide_volume||'0')
            +' studies['+s.length+']:'+(s.join(',')||'-');
        }catch(e){return 'unparsed: '+e.message}}),
    }))));
    document.body.appendChild(o);
  }, ${settleMs});
}, 5500));
</script>`;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('</head>', probe + '</head>');
fs.writeFileSync(path.join(ROOT, '__probe.html'), html);

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dom = execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--window-size=${w},${h}`, `--virtual-time-budget=${settleMs + 15000}`,
  `--screenshot=${path.join(OUT, name + '.png')}`, '--dump-dom',
  'http://localhost:8099/__probe.html',
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

const m = dom.match(/<pre id="RESULTBLOCK"[^>]*>([A-Za-z0-9+/=]+)<\/pre>/);
if (!m) { console.log(`${name.padEnd(10)} NO RESULT (page did not settle)`); process.exit(1); }
const d = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
const overflow = d.bodyW > d.winW ? `  ⚠ H-OVERFLOW ${d.bodyW}>${d.winW}` : '';
console.log(`${name.padEnd(10)} errors:${d.errors.length}  cells:${d.cells} iframes:${d.iframes}  [${d.symbols.join(' ')}]${overflow}`);
d.srcs.forEach(s => console.log('    widget: ' + s));
d.errors.forEach(e => console.log('    ✗ ' + e));
if (d.errors.length) process.exitCode = 1;
