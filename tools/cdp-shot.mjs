/* Screenshot a page using the DevTools Protocol with real wall-clock waiting.

   `chrome --screenshot --virtual-time-budget` fast-forwards timers, which
   starves the WebSocket that TradingView's widget streams its candles over —
   the chrome renders but the chart stays empty. Driving CDP lets the page
   load in real time, so what lands in the PNG is what a browser would show.

   Usage: node tools/cdp-shot.mjs <url> <out.png> [waitMs] [width] [height] */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, out, waitMs = '25000', width = '1500', height = '940'] = process.argv.slice(2);
if (!url || !out) { console.error('usage: cdp-shot.mjs <url> <out.png> [waitMs] [w] [h]'); process.exit(2); }

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome never opened its debugging port');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);           // Node 22+ has WebSocket built in
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')));
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  });
}

try {
  const browser = await connect(await endpoint());
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => browser.send(m, p, sessionId);

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride',
    { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
  await s('Page.navigate', { url });
  // Optional interaction: a JS file run once the shell is up, followed by a
  // second settle so any widget it creates has time to stream its data.
  const driver = process.env.CDP_DRIVER;
  if (driver && fs.existsSync(driver)) {
    await sleep(3000);
    await s('Runtime.evaluate', { expression: fs.readFileSync(driver, 'utf8'), awaitPromise: true });
  }
  await sleep(+waitMs);                         // real time, so sockets actually run

  const probe = await s('Runtime.evaluate', {
    expression: `(${() => {
      const iframes = [...document.querySelectorAll('.chart-mount iframe')];
      return JSON.stringify({
        cells: document.querySelectorAll('.cell').length,
        iframes: iframes.length,
        symbols: [...document.querySelectorAll('.sym-input')].map(x => x.value),
        errors: window.__err || [],
      });
    }})()`,
    returnByValue: true,
  });
  console.log('page:', probe.result?.value ?? '(no probe)');

  const shot = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  browser.close();
} finally {
  chrome.kill();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 500);
}
