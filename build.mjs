/* Assembles src/* into the single index.html that GitHub Pages serves.
   The parts exist so the math and data layers can be unit-tested in Node;
   the output stays one self-contained file with no build step at deploy time.
   Run: node build.mjs   (or `node build.mjs --check` to verify it is current) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');

const LIBS = [
  'https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js',
];
const STYLES = [
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css',
];

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="description" content="Live trading charts — accurate candles, 41 indicators, session-aware VWAP and pivots.">
<meta name="theme-color" content="#0B0E14">
<meta name="referrer" content="no-referrer">
<title>Trading Charts</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B0E14'/%3E%3Crect x='8' y='11' width='4' height='13' fill='%232EBD85'/%3E%3Crect x='9.2' y='7' width='1.6' height='19' fill='%232EBD85'/%3E%3Crect x='19' y='8' width='4' height='11' fill='%23F0616D'/%3E%3Crect x='20.2' y='5' width='1.6' height='18' fill='%23F0616D'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://data.alpaca.markets" crossorigin>
<link rel="preconnect" href="https://paper-api.alpaca.markets" crossorigin>
${STYLES.map(h => `<link rel="stylesheet" href="${h}" crossorigin="anonymous">`).join('\n')}
${LIBS.map(s => `<script src="${s}" crossorigin="anonymous" defer></script>`).join('\n')}
<style>
${src('style.css').trim()}
</style>
</head>
<body>
${src('body.html').trim()}
<script>
${src('ta.js').trim()}
</script>
<script>
${src('data.js').trim()}
</script>
<script>
${src('app.js').trim()}
</script>
</body>
</html>
`;

const out = path.join(ROOT, 'index.html');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (current !== html) {
    console.error('index.html is stale — run `node build.mjs`');
    process.exit(1);
  }
  console.log('index.html is up to date');
} else {
  fs.writeFileSync(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`built index.html — ${kb} KB, ${html.split('\n').length} lines`);
}
