/* Morning-brief reel: an animated vertical video (1080×1920, 30 fps) with a voice-over and word-by-word captions.
     node scanner/reel.mjs brief.json out.mp4
   brief.json: { "date": "Tue Nov 24", "scenes": [ scene, ... ] }   Every scene has "say" (what the voice reads) and one "type":
     title    { kicker, headline, cards: [{ label, value, change }], spark: [numbers], sparkLabel }
     grid     { kicker, title, tiles: [{ label, value, change }] }            change like "+2.5%" / "-0.4%" (sign sets the colour)
     list     { kicker, title, items: [{ who, text, src }] }                 who = short badge ("TRUMP", "MUSK", "NVDA")
     calendar { kicker, title, rows: [{ time, what }] }
     bot      { kicker, value, change, rows: [{ label, value, change }], curve: [numbers], holdings: [{ sym, w }] }
     outro    { kicker, title, items: [strings], foot }
   Voice (first one available): Kokoro (KOKORO_MODEL + KOKORO_VOICES [.npz] + KOKORO_VOICE, run via scanner/tts_kokoro.py),
   else Piper (PIPER_VOICE), else silent. Needs Playwright and ffmpeg. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FPS = 30, W = 1080, H = 1920;
const here = path.dirname(fileURLToPath(import.meta.url));
const seconds = f => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();

export function speak(text, wav) {
  const e = process.env;
  if (e.KOKORO_MODEL && e.KOKORO_VOICES) { execFileSync('python3', [path.join(here, 'tts_kokoro.py'), e.KOKORO_MODEL, e.KOKORO_VOICES, e.KOKORO_VOICE || 'af_heart', e.KOKORO_SPEED || '1.08', wav], { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); return true; }
  if (e.PIPER_VOICE) { execFileSync('python3', ['-m', 'piper', '-m', e.PIPER_VOICE, '-f', wav], { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); return true; }
  return false;
}

// Caption timing: spread the words over the spoken time, longer words and pauses after punctuation take longer.
export function wordTimes(text, start, dur) {
  const ws = text.split(/\s+/).filter(Boolean), weight = w => w.replace(/[^\w]/g, '').length + 2 + (/[.,;:!?—]$/.test(w) ? 4 : 0);
  const tot = ws.reduce((a, w) => a + weight(w), 0) || 1; let t = start; const out = [];
  for (const w of ws) { const d = dur * weight(w) / tot; out.push({ w, t0: t, t1: t + d }); t += d; } return out;
}

const PAGE = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#06080d;font-family:Inter,"SF Pro Display",-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff}
#bg{position:absolute;inset:0;overflow:hidden}.blob{position:absolute;width:1100px;height:1100px;border-radius:50%;filter:blur(140px);opacity:.55}
#grain{position:absolute;inset:0;opacity:.06;background-image:radial-gradient(#fff 1px,transparent 1px);background-size:4px 4px}
#bars{position:absolute;top:60px;left:50px;right:50px;display:flex;gap:10px}#bars div{flex:1;height:8px;border-radius:4px;background:#ffffff33;overflow:hidden}#bars i{display:block;height:100%;width:0;background:#fff}
#brand{position:absolute;top:100px;left:56px;right:56px;display:flex;justify-content:space-between;font-size:30px;font-weight:700;letter-spacing:4px;color:#ffffffb0;text-transform:uppercase}
.scene{position:absolute;left:0;right:0;top:220px;bottom:560px;padding:0 64px;display:flex;flex-direction:column}
.kick{font-size:34px;font-weight:800;letter-spacing:6px;text-transform:uppercase;color:#7dd3fc}
.head{font-size:94px;font-weight:900;line-height:1.02;letter-spacing:-2px;margin-top:22px}.head span{display:inline-block;margin-right:22px}
.cards{display:flex;gap:22px;margin-top:46px}.card{flex:1;background:#ffffff10;border:1px solid #ffffff1f;border-radius:34px;padding:30px 26px;backdrop-filter:blur(8px)}
.lab{font-size:30px;font-weight:700;color:#ffffffa0}.val{font-size:64px;font-weight:900;margin-top:8px;letter-spacing:-1px}.chg{font-size:40px;font-weight:800;margin-top:6px}
.up{color:#34d399}.dn{color:#fb7185}.flat{color:#cbd5e1}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:40px}.grid .card{padding:34px}
.item{display:flex;gap:26px;align-items:flex-start;background:#ffffff0d;border:1px solid #ffffff1a;border-radius:32px;padding:30px;margin-top:24px}
.badge{flex:none;min-width:150px;text-align:center;font-size:30px;font-weight:900;letter-spacing:2px;padding:16px 18px;border-radius:20px;background:linear-gradient(135deg,#38bdf8,#6366f1)}
.itxt{font-size:44px;font-weight:700;line-height:1.2}.isrc{font-size:28px;color:#ffffff80;margin-top:8px;font-weight:600}
.row{display:flex;gap:30px;align-items:center;padding:30px 0;border-bottom:2px solid #ffffff14}.time{width:240px;font-size:52px;font-weight:900;color:#7dd3fc}.what{font-size:48px;font-weight:700}
.bigv{font-size:170px;font-weight:900;letter-spacing:-4px;line-height:1;margin-top:26px}
.hold{display:flex;align-items:center;gap:18px;margin-top:14px}.hs{width:130px;font-size:34px;font-weight:800}.hb{height:34px;border-radius:17px;background:linear-gradient(90deg,#34d399,#38bdf8)}.hw{font-size:30px;font-weight:700;color:#ffffffb0}
svg{display:block}
#cap{position:absolute;left:60px;right:60px;bottom:250px;text-align:center;font-size:82px;font-weight:900;line-height:1.12;letter-spacing:-1px;text-shadow:0 6px 30px #000c}
#cap span{display:inline-block;margin:0 12px;padding:2px 14px;border-radius:18px}#cap .on{background:#facc15;color:#111;text-shadow:none}
#foot{position:absolute;left:0;right:0;bottom:120px;text-align:center;font-size:28px;color:#ffffff70;font-weight:600}
</style><div id="bg"><div class="blob" id="b1"></div><div class="blob" id="b2"></div><div class="blob" id="b3"></div><div id="grain"></div></div>
<div id="bars"></div><div id="brand"><span>Morning Brief</span><span id="date"></span></div><div id="stage"></div><div id="cap"></div><div id="foot">Not financial advice</div>
<script>
const ease=x=>1-Math.pow(1-Math.min(1,Math.max(0,x)),3), clamp=x=>Math.min(1,Math.max(0,x));
const cls=c=>/^[+▲]/.test(c)?'up':/^[-−▼]/.test(c)?'dn':'flat', arrow=c=>/^[+▲]/.test(c)?'▲ ':/^[-−▼]/.test(c)?'▼ ':'';
const esc=s=>String(s??'').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
function countTo(str,p){const m=String(str).match(/^([^0-9-]*)(-?[0-9][0-9,]*\\.?[0-9]*)(.*)$/);if(!m)return str;const n=parseFloat(m[2].replace(/,/g,'')),dec=(m[2].split('.')[1]||'').length,v=n*ease(p);return m[1]+v.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec})+m[3]}
function spark(vals,w,h,p,color){if(!vals||vals.length<2)return'';const lo=Math.min(...vals),hi=Math.max(...vals),pts=vals.map((v,i)=>[i/(vals.length-1)*w,h-(v-lo)/((hi-lo)||1)*h*0.9-h*0.05]);
 const d=pts.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join(' '),len=pts.reduce((a,q,i)=>i?a+Math.hypot(q[0]-pts[i-1][0],q[1]-pts[i-1][1]):0,0);
 return '<svg width="'+w+'" height="'+h+'"><defs><linearGradient id="gf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+color+'" stop-opacity=".35"/><stop offset="1" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs><path d="'+d+' L '+w+' '+h+' L 0 '+h+' Z" fill="url(#gf)" opacity="'+ease(p*1.3-0.3)+'"/><path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="'+len+'" stroke-dashoffset="'+(len*(1-ease(p)))+'"/></svg>'}
const pop=(p,dy=60)=>'opacity:'+ease(p)+';transform:translateY('+((1-ease(p))*dy)+'px) scale('+(0.94+0.06*ease(p))+')';
function sceneHtml(s,lt){const a=k=>clamp((lt-k)/0.45);let h='<div class="kick" style="'+pop(a(0),20)+'">'+esc(s.kicker)+'</div>';
 if(s.type==='title'){h+='<div class="head">'+String(s.headline).split(' ').map((w,i)=>'<span style="'+pop(a(0.15+i*0.07),50)+'">'+esc(w)+'</span>').join('')+'</div>';
  h+='<div class="cards">'+(s.cards||[]).map((c,i)=>{const p=a(0.8+i*0.15);return '<div class="card" style="'+pop(p)+'"><div class="lab">'+esc(c.label)+'</div><div class="chg '+cls(c.change)+'" style="font-size:58px">'+arrow(c.change)+esc(countTo(c.change.replace(/^[+-]/,''),p*1.2))+'</div></div>'}).join('')+'</div>';
  if(s.spark)h+='<div style="margin-top:40px;'+pop(a(1.2))+'"><div class="lab" style="margin-bottom:14px">'+esc(s.sparkLabel||'')+'</div>'+spark(s.spark,950,300,clamp((lt-1.2)/1.6),'#38bdf8')+'</div>'}
 if(s.type==='grid'){h+='<div class="head" style="font-size:78px">'+esc(s.title)+'</div><div class="grid">'+(s.tiles||[]).map((c,i)=>{const p=a(0.3+i*0.12);return '<div class="card" style="'+pop(p)+'"><div class="lab">'+esc(c.label)+'</div><div class="val">'+esc(countTo(c.value,p*1.2))+'</div>'+(c.change?'<div class="chg '+cls(c.change)+'">'+arrow(c.change)+esc(c.change.replace(/^[+-]/,''))+'</div>':'')+'</div>'}).join('')+'</div>'}
 if(s.type==='list'){h+='<div class="head" style="font-size:78px">'+esc(s.title)+'</div>'+(s.items||[]).map((it,i)=>{const p=a(0.4+i*Math.max(0.5,(s.dur-1)/Math.max(1,(s.items||[]).length)));return '<div class="item" style="'+pop(p,80)+'"><div class="badge">'+esc(it.who)+'</div><div><div class="itxt">'+esc(it.text)+'</div>'+(it.src?'<div class="isrc">'+esc(it.src)+'</div>':'')+'</div></div>'}).join('')}
 if(s.type==='calendar'){h+='<div class="head" style="font-size:78px">'+esc(s.title)+'</div><div style="margin-top:30px">'+(s.rows||[]).map((r,i)=>'<div class="row" style="'+pop(a(0.3+i*0.25),40)+'"><div class="time">'+esc(r.time)+'</div><div class="what">'+esc(r.what)+'</div></div>').join('')+'</div>'}
 if(s.type==='bot'){const p=a(0.2);h+='<div class="bigv '+cls(s.change||'')+'" style="'+pop(p)+'">'+esc(countTo(s.value,p*1.1))+'</div><div class="chg '+cls(s.change||'')+'" style="'+pop(a(0.5))+';font-size:46px">'+arrow(s.change||'')+esc((s.change||'').replace(/^[+-]/,''))+'</div>';
  h+='<div class="cards" style="margin-top:30px">'+(s.rows||[]).map((c,i)=>'<div class="card" style="'+pop(a(0.7+i*0.15))+'"><div class="lab">'+esc(c.label)+'</div><div class="chg '+cls(c.value)+'" style="font-size:50px">'+arrow(c.value)+esc(c.value.replace(/^[+-]/,''))+'</div></div>').join('')+'</div>';
  if(s.curve)h+='<div style="margin-top:30px;'+pop(a(1.0))+'">'+spark(s.curve,950,200,clamp((lt-1)/1.4),/^-|−/.test(s.change||'')?'#fb7185':'#34d399')+'</div>';
  const mx=Math.max(...(s.holdings||[]).map(x=>x.w),1);h+='<div style="margin-top:20px">'+(s.holdings||[]).slice(0,6).map((x,i)=>{const q=a(1.3+i*0.12);return '<div class="hold" style="opacity:'+ease(q)+'"><div class="hs">'+esc(x.sym)+'</div><div class="hb" style="width:'+(ease(q)*x.w/mx*620)+'px"></div><div class="hw">'+Math.round(x.w)+'%</div></div>'}).join('')+'</div>'}
 if(s.type==='outro'){h+='<div class="head" style="font-size:84px">'+esc(s.title)+'</div>'+(s.items||[]).map((x,i)=>'<div class="item" style="'+pop(a(0.4+i*0.6),60)+'"><div class="badge" style="min-width:90px">'+(i+1)+'</div><div class="itxt">'+esc(x)+'</div></div>').join('')}
 return h}
window.setup=B=>{window.B=B;document.getElementById('date').textContent=B.date||'';document.getElementById('bars').innerHTML=B.scenes.map(()=>'<div><i></i></div>').join('')};
window.render=t=>{const B=window.B,b=['#1d4ed8','#7c3aed','#0e7490'];['b1','b2','b3'].forEach((id,i)=>{const e=document.getElementById(id);e.style.background=b[i];e.style.left=(-300+i*420+Math.sin(t*0.25+i*2)*160)+'px';e.style.top=(-200+i*700+Math.cos(t*0.2+i)*180)+'px'});
 let k=B.scenes.findIndex(s=>t<s.start+s.dur);if(k<0)k=B.scenes.length-1;const s=B.scenes[k],lt=t-s.start;
 document.querySelectorAll('#bars i').forEach((e,i)=>e.style.width=(i<k?100:i>k?0:clamp(lt/s.dur)*100)+'%');
 const out=clamp((s.dur-lt)/0.35),inn=clamp(lt/0.35),st=document.getElementById('stage');
 st.innerHTML='<div class="scene" style="opacity:'+Math.min(out,inn)+';transform:translateX('+((1-ease(inn))*120-(1-out)*120)+'px)">'+sceneHtml(s,lt)+'</div>';
 const ws=s.words||[],cur=ws.findIndex(w=>t>=w.t0&&t<w.t1);let html='';if(cur>=0){const g=Math.floor(cur/3)*3;html=ws.slice(g,g+3).map((w,i)=>'<span class="'+(g+i===cur?'on':'')+'">'+esc(w.w.replace(/[,.;:]$/,''))+'</span>').join('')}
 document.getElementById('cap').innerHTML=html};
</script>`;

export async function makeReel(brief, out, { work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-')) } = {}) {
  // 1) voice per scene → durations and caption timing
  let t = 0, voiced = 0; const wavs = [];
  for (const [i, s] of brief.scenes.entries()) {
    const wav = path.join(work, `v${i}.wav`); let spoken = 0;
    if (s.say && speak(s.say, wav)) { spoken = seconds(wav); voiced++; wavs.push({ wav, at: t + 0.35 }); }
    s.dur = Math.max(3.2, spoken + 0.9); s.start = t;
    s.words = spoken ? wordTimes(s.say, t + 0.35, spoken) : []; t += s.dur;
  }
  const total = t;
  // 2) frames → ffmpeg (video only)
  const { chromium } = createRequire(import.meta.url)('playwright');
  const br = await chromium.launch(); const pg = await br.newPage({ viewport: { width: W, height: H } });
  await pg.setContent(PAGE); await pg.evaluate(B => window.setup(B), brief);
  const silent = path.join(work, 'video.mp4');
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', silent], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', c => c ? rej(new Error('ffmpeg ' + c)) : res()));
  const n = Math.ceil(total * FPS);
  for (let f = 0; f < n; f++) { await pg.evaluate(x => window.render(x), f / FPS); const jpg = await pg.screenshot({ type: 'jpeg', quality: 88 }); if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r)); }
  ff.stdin.end(); await done; await br.close();
  // 3) lay each scene's voice at its start time, then mux
  if (wavs.length) {
    const args = ['-y', '-v', 'error', '-i', silent]; wavs.forEach(w => args.push('-i', w.wav));
    const f = wavs.map((w, i) => `[${i + 1}:a]aresample=44100,adelay=${Math.round(w.at * 1000)}:all=1[a${i}]`).join(';') + `;${wavs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${wavs.length}:normalize=0,loudnorm=I=-16:TP=-1.5[a]`;
    execFileSync('ffmpeg', [...args, '-filter_complex', f, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', String(total), '-movflags', '+faststart', out]);
  } else fs.copyFileSync(silent, out);
  return { seconds: total, scenes: brief.scenes.length, voiced };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inp, out = 'reel.mp4'] = process.argv.slice(2);
  if (!inp) { console.error('usage: node scanner/reel.mjs brief.json out.mp4'); process.exit(2); }
  makeReel(JSON.parse(fs.readFileSync(inp, 'utf8')), out).then(r => console.log(`${out}: ${r.seconds.toFixed(1)}s, ${r.scenes} scenes, ${r.voiced} voiced`), e => { console.error(e.message); process.exit(1); });
}
