/* Assembles src/* into the single index.html that GitHub Pages serves.
   The charts themselves are TradingView's embedded widgets, so there is no
   data or indicator code to inline any more — see archive/lightweight-engine
   for the self-rendered engine this replaced.
   Run: node build.mjs   (or `node build.mjs --check` to verify it is current) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="description" content="Multi-chart trading workspace built on TradingView charts.">
<meta name="theme-color" content="#0B0E14">
<title>Trading Charts</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B0E14'/%3E%3Crect x='8' y='11' width='4' height='13' fill='%232EBD85'/%3E%3Crect x='9.2' y='7' width='1.6' height='19' fill='%232EBD85'/%3E%3Crect x='19' y='8' width='4' height='11' fill='%23F0616D'/%3E%3Crect x='20.2' y='5' width='1.6' height='18' fill='%23F0616D'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://s3.tradingview.com" crossorigin>
<link rel="preconnect" href="https://s.tradingview.com" crossorigin>
<script src="https://s3.tradingview.com/tv.js"></script>
<style>
${src('style.css').trim()}
</style>
</head>
<body>
${src('body.html').trim()}
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
  console.log(`built index.html — ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB, ${html.split('\n').length} lines`);
}
