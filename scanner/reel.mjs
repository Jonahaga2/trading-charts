/* Morning-brief reel: vertical 1080×1920 slides with a spoken voice-over.
     node scanner/reel.mjs brief.json out.mp4
   brief.json: { "date": "Tue Nov 24", "slides": [ { "tag", "title", "big", "bigColor", "rows": [[left, right, "g"|"r"|""]],
                 "bullets": [..], "chips": [..], "foot", "say": "what the voice reads" } ] }
   Voice: Piper (free, runs offline). Needs `pip install piper-tts` and a voice model;
   set PIPER_VOICE to the .onnx path, or the reel is made silent. Needs ffmpeg and Playwright. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CSS = `*{box-sizing:border-box;margin:0}body{width:1080px;height:1920px;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#f5f7fa;
background:radial-gradient(1200px 900px at 20% 10%,#1d3a6e 0%,#0b1220 55%,#05080f 100%);padding:150px 90px;display:flex;flex-direction:column}
.tag{font-size:38px;letter-spacing:6px;color:#7dd3fc;font-weight:700;text-transform:uppercase}.h{font-size:92px;font-weight:800;line-height:1.05;margin:30px 0 50px}
.big{font-size:150px;font-weight:900;line-height:1;margin:30px 0 20px}.row{display:flex;justify-content:space-between;align-items:baseline;gap:30px;font-size:60px;font-weight:700;padding:32px 0;border-bottom:2px solid #ffffff1a}
.row span:last-child{text-align:right}.g{color:#4ade80}.r{color:#f87171}.m{color:#94a3b8}ul{list-style:none;padding:0}
li{font-size:50px;line-height:1.25;font-weight:600;padding:28px 0 28px 50px;position:relative}li:before{content:"";position:absolute;left:0;top:50px;width:20px;height:20px;border-radius:50%;background:#38bdf8}
.foot{margin-top:auto;font-size:34px;color:#94a3b8}.chip{display:inline-block;font-size:40px;font-weight:700;padding:14px 28px;border-radius:40px;background:#ffffff14;margin:12px 12px 0 0}`;

export function slideHtml(s) {
  let b = `<div class="tag">${esc(s.tag)}</div>`;
  if (s.title) b += `<div class="h">${esc(s.title)}</div>`;
  if (s.big) b += `<div class="big ${esc(s.bigColor || '')}">${esc(s.big)}</div>`;
  for (const [l, r, c] of s.rows || []) b += `<div class="row"><span>${esc(l)}</span><span class="${esc(c || '')}">${esc(r)}</span></div>`;
  if (s.bullets?.length) b += `<ul>${s.bullets.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  if (s.chips?.length) b += `<div style="margin-top:30px">${s.chips.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>`;
  if (s.foot) b += `<div class="foot">${esc(s.foot)}</div>`;
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${b}</body>`;
}

const seconds = file => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();

export async function makeReel(brief, out, { voice = process.env.PIPER_VOICE, work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-')) } = {}) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const br = await chromium.launch(); const pg = await br.newPage({ viewport: { width: 1080, height: 1920 } });
  const parts = [];
  for (let i = 0; i < brief.slides.length; i++) {
    const s = brief.slides[i], png = path.join(work, `s${i}.png`);
    await pg.setContent(slideHtml(s)); await pg.screenshot({ path: png });
    let wav = null, dur = 4;
    if (voice && s.say) {
      wav = path.join(work, `s${i}.wav`);
      execFileSync('python3', ['-m', 'piper', '-m', voice, '-f', wav], { input: s.say });
      dur = Math.max(3, seconds(wav) + 0.7);
    }
    parts.push({ png, wav, dur });
  }
  await br.close();
  // One clip per slide (image + its voice, padded to the slide's length), then join them.
  const clips = parts.map((p, i) => {
    const clip = path.join(work, `c${i}.mp4`);
    const audio = p.wav ? ['-i', p.wav] : ['-f', 'lavfi', '-t', String(p.dur), '-i', 'anullsrc=r=22050:cl=mono'];
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-loop', '1', '-framerate', '30', '-t', String(p.dur), '-i', p.png, ...audio,
      '-filter_complex', `[0:v]scale=1080:1920,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.25[v];[1:a]apad,atrim=0:${p.dur},aresample=44100[a]`,
      '-map', '[v]', '-map', '[a]', '-t', String(p.dur), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', clip]);
    return clip;
  });
  const list = path.join(work, 'list.txt'); fs.writeFileSync(list, clips.map(c => `file '${c}'`).join('\n'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
  return { seconds: seconds(out), slides: parts.length, voiced: parts.filter(p => p.wav).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inp, out = 'reel.mp4'] = process.argv.slice(2);
  if (!inp) { console.error('usage: node scanner/reel.mjs brief.json out.mp4'); process.exit(2); }
  makeReel(JSON.parse(fs.readFileSync(inp, 'utf8')), out).then(r => console.log(`${out}: ${r.seconds.toFixed(1)}s, ${r.slides} slides, ${r.voiced} voiced`), e => { console.error(e.message); process.exit(1); });
}
