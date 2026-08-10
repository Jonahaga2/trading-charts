/* Diagnose a page including inside cross-origin iframes: console messages,
   failed network requests and JS exceptions from every target.
   Usage: node tools/cdp-diag.mjs <url> [waitMs] */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, waitMs = '25000'] = process.argv.slice(2);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpd-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return (await r.json()).webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('no debugging port');
}

const failures = [], consoles = [], exceptions = [];

const ws = new WebSocket(await wsUrl());
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const msgId = ++id; pending.set(msgId, { res, rej });
  ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
});

await new Promise(r => ws.addEventListener('open', r));

ws.addEventListener('message', async ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    return m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
  const p = m.params || {};
  // Auto-attach to every new target so out-of-process iframes are covered.
  if (m.method === 'Target.attachedToTarget') {
    const sid = p.sessionId;
    try {
      await send('Runtime.enable', {}, sid);
      await send('Log.enable', {}, sid);
      await send('Network.enable', {}, sid);
      await send('Runtime.runIfWaitingForDebugger', {}, sid);
    } catch {}
  }
  if (m.method === 'Network.loadingFailed') failures.push(`${p.type} ${p.errorText}${p.blockedReason ? ' blocked:' + p.blockedReason : ''}`);
  if (m.method === 'Network.responseReceived' && p.response && p.response.status >= 400)
    failures.push(`HTTP ${p.response.status} ${String(p.response.url).slice(0, 120)}`);
  if (m.method === 'Log.entryAdded' && p.entry && p.entry.level !== 'verbose')
    consoles.push(`[${p.entry.level}] ${String(p.entry.text).slice(0, 200)}`);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type))
    consoles.push(`[${p.type}] ${(p.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`);
  if (m.method === 'Runtime.exceptionThrown')
    exceptions.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 300));
});

await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);
// Optional interaction, same contract as cdp-shot: a JS file run once the
// shell is up, so a failure that only appears after a rebuild is catchable.
const driver = process.env.CDP_DRIVER;
if (driver && fs.existsSync(driver)) {
  await sleep(4000);
  await send('Runtime.evaluate', { expression: fs.readFileSync(driver, 'utf8'), awaitPromise: true }, sessionId);
}
await sleep(Number(waitMs));

const dump = (title, arr) => {
  const uniq = [...new Set(arr)];
  console.log(`\n${title} (${uniq.length})`);
  uniq.slice(0, 25).forEach(x => console.log('  ' + x));
  if (!uniq.length) console.log('  none');
};
dump('NETWORK FAILURES', failures);
dump('CONSOLE', consoles);
dump('EXCEPTIONS', exceptions);

ws.close(); chrome.kill();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 400);
