/* Local preview server.

   Binds to 127.0.0.1 only — `python -m http.server` defaults to 0.0.0.0, which
   quietly publishes the whole working directory, .git included, to every
   device on the network. This serves the built page and refuses dotfiles and
   anything that tries to climb out of the repo.

   Usage: node tools/serve.mjs [port]        (default 8099) */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2]) || 8099;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const rel = decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (rel.split('/').some(seg => seg.startsWith('.'))) return send(403, 'forbidden');

    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) return send(403, 'forbidden');

    const body = await fs.readFile(file);
    send(200, body, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (e) {
    send(e.code === 'ENOENT' ? 404 : 500, e.code === 'ENOENT' ? 'not found' : 'server error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT}`);
  console.log(`http://localhost:${PORT}  (127.0.0.1 only — not reachable from the network)`);
});
