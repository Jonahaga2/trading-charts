// Run one backtest: the engine + one test file, joined into one script (the tests use the engine's variables).
//   node research/run.mjs tests/stops.mjs
// Needs the price data in research/data (see research/README.md) and ~7 GB of memory.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname);
const test = process.argv[2];
if (!test) { console.error('usage: node research/run.mjs tests/<name>.mjs'); process.exit(2); }
const build = path.join(here, '.build'); fs.mkdirSync(build, { recursive: true });
const out = path.join(build, path.basename(test));
fs.writeFileSync(out, fs.readFileSync(path.join(here, 'engine.mjs'), 'utf8') + '\n' + fs.readFileSync(path.resolve(here, test), 'utf8'));
const r = spawnSync(process.execPath, ['--max-old-space-size=7000', out], { stdio: 'inherit', env: { ...process.env, DATA_DIR: process.env.DATA_DIR || path.join(here, 'data') } });
process.exit(r.status ?? 1);
