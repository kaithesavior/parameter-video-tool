// Browser end-to-end checks: drives the real editor in headless Chrome over the
// DevTools Protocol, with no npm dependencies.
//   npm run test:e2e                 (set CHROME_PATH if Chrome is not in the default place)
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME =
  process.env.CHROME_PATH ||
  {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  }[process.platform];
if (!CHROME || !existsSync(CHROME)) {
  console.log('Skipped: Chrome not found. Set CHROME_PATH to run the browser tests.');
  process.exit(0);
}
const PORT = 4198, DBG = 9339, BASE = `http://127.0.0.1:${PORT}`;
const profile = mkdtempSync(join(tmpdir(), 'stickies-e2e-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The test server saves imported videos in a temporary folder, never in the project's videos/.
const videosDir = mkdtempSync(join(tmpdir(), 'stickies-e2e-videos-'));
// The test video. There is no built-in example, so the library starts with this one.
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'sample.mov');
const addSample = () => copyFileSync(FIXTURE, join(videosDir, 'sample.mov'));
addSample();
const server = spawn('node', ['server/server.cjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), VIDEOS_DIR: videosDir } });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--mute-audio', 'about:blank',
]);
let ws, id = 0;
const pending = new Map(), logs = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(200);
  }
  await new Promise(r => (ws.onopen = r));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
      logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + m.params.exceptionDetails.exception?.description);
  };
}
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  // A step that never settles is reported as a failure instead of hanging the whole run.
  const timeout = sleep(30000).then(() => ({ result: { result: { value: 'TIMEOUT: ' + expr.slice(0, 120) } } }));
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, userGesture: true }),
    timeout,
  ]);
  if (r.result.exceptionDetails) return 'THROW: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
}
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (process.env.E2E_PROGRESS) console.error(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
const post = body => fetch(`${BASE}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

try {
  await sleep(600);
  await connect();
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);

  // 1. Load
  let r = await ev(`return {src: $('source').textContent, dur: duration, rs: video.readyState, status: $('status').textContent}`);
  check('The first library video opens at start', r.rs >= 2 && r.dur > 0 && /^sample\.mov/.test(r.src), JSON.stringify(r));
  r = await ev(`openExportDialog(); const csv=$('export-csv').disabled, name=$('export-timeline-name').textContent; $('export-dialog').close(); return {selected: $('preset-select').value, cuesDisabled: document.querySelector('input[name=control-mode][value=cues]').disabled, empty: !$('cues-empty').hidden, editor: $('cues-editor').hidden, timeline: $('schedule-name').textContent, chart: $('schedule-chart').textContent.includes('No cue timeline'), csv, name, view: {speed: p.speed, zoom: p.zoom, x: p.x, y: p.y}}`);
  check('A video starts with no cue timeline and neutral View', r.selected === '' && r.cuesDisabled && r.empty && r.editor && r.timeline === 'No cue timeline' && r.chart && r.view.speed === 1 && r.view.zoom === 1 && r.view.x === 50, JSON.stringify(r));
  check('Timeline export is unavailable without a timeline', r.csv && r.name === 'none selected', JSON.stringify(r));
  r = await ev(`return {muscle: typeof drawMuscleHighlight, panel: !!document.querySelector('.muscle-panel')}`);
  check('Muscle highlight is removed', r.muscle === 'undefined' && !r.panel, JSON.stringify(r));

  // 2. Play / pause
  r = await ev(`$('play').click(); await new Promise(r=>setTimeout(r,400)); const t0=time; await new Promise(r=>setTimeout(r,1000)); const t1=time; $('play').click(); return {rate: (t1-t0), playing}`);
  check('Play runs at 1×, pause stops', Math.abs(r.rate - 1) < 0.15 && !r.playing, JSON.stringify(r));
  r = await ev(`const ev=new KeyboardEvent('keydown',{code:'Space',bubbles:true}); document.body.dispatchEvent(ev); await new Promise(r=>setTimeout(r,300)); const a=playing; document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true})); return {a, b: playing}`);
  check('Space toggles play', r.a === true && r.b === false, JSON.stringify(r));
  r = await ev(`$('to-start').click(); await new Promise(r=>setTimeout(r,400)); return time`);
  check('Go to start', r < 0.05, 't=' + r);

  // 3. Speed / zoom / focus
  r = await ev(`document.querySelector('[data-quick-key=speed][data-quick-value="2"]').click(); return {p: p.speed, rate: video.playbackRate, pressed: document.querySelector('[data-quick-key=speed][data-quick-value="2"]').getAttribute('aria-pressed')}`);
  check('Speed quick button 2×', r.p === 2 && r.rate === 2 && r.pressed === 'true', JSON.stringify(r));
  r = await ev(`const el=$('zoom-number'); el.value='9'; el.dispatchEvent(new Event('input')); return p.zoom`);
  check('Zoom input clamps to max 5', r === 5, 'zoom=' + r);
  r = await ev(`const c=canvas.getBoundingClientRect(); const o={clientX:c.left+c.width*0.75, clientY:c.top+c.height*0.25, pointerId:1, bubbles:true}; canvas.dispatchEvent(new PointerEvent('pointerdown',o)); canvas.dispatchEvent(new PointerEvent('pointerup',o)); return {x:p.x, y:p.y}`);
  check('Canvas click sets focus', r.x > 50 && r.y < 50, JSON.stringify(r));
  r = await ev(`$('focus-center').click(); return {x:p.x,y:p.y}`);
  check('Center focus', r.x === 50 && r.y === 50, JSON.stringify(r));
  r = await ev(`$('reset').click(); return {zoom:p.zoom, speed:p.speed}`);
  check('Reset parameters', r.zoom === 1 && r.speed === 1, JSON.stringify(r));
  r = await ev(`$('compare').checked=true; const g=geometry().z; $('compare').checked=false; return g`);
  check('Original (compare) shows 1× view', r === 1);

  // 4. Zoom animation
  r = await ev(`p.zoom=3; p.animate=true; p.start=0; p.end=2; sync(); const a=zoomAt(0), b=zoomAt(1), c=zoomAt(2); p.animate=false; p.zoom=1; sync(); return [a,b,c]`);
  check('Zoom animation eases 1→3', r[0] === 1 && r[1] === 2 && r[2] === 3, JSON.stringify(r));

  // 5. Layout: one Import, one Export, and a Manual / Cues / Live control
  r = await ev(`return {old: ['load','save','recipe','preset-play','preset-stop','live-enable','preset-file','schedule-csv'].filter(id => $(id)), modes: [...document.querySelectorAll('input[name=control-mode]')].map(i => i.value), open: $('open').textContent.trim(), exportLabel: $('export').textContent.trim()}`);
  check('Toolbar has one Import and one Export; old buttons are gone', r.old.length === 0 && r.open === 'Import' && r.exportLabel === 'Export', JSON.stringify(r));
  check('Control offers Manual, Cues and Live', JSON.stringify(r.modes) === '["manual","cues","live"]', JSON.stringify(r.modes));
  const mode = m => `document.querySelector('input[name=control-mode][value=${m}]').click();`;
  const settle = ms => `await new Promise(r=>setTimeout(r,${ms}));`;

  // 6. Cues mode and cue timelines
  r = await ev(`$('preset-select').value='builtin-bold'; $('preset-select').onchange(); ${mode('cues')} await seekTo(duration * 0.4); ${settle(100)} const atCue={mode: controlMode, following: !!attachedPreset, zoom: p.zoom, speed: p.speed}; $('play').click(); ${settle(300)} const badge=$('control-state').textContent; pause(); return {...atCue, badge}`);
  check('Cues mode follows the selected timeline', r.mode === 'cues' && r.following && Math.abs(r.zoom - 2.8) < 1e-6 && Math.abs(r.speed - 0.3) < 1e-6 && r.badge === 'Playing cues', JSON.stringify(r));
  r = await ev(`${mode('cues')} return {add: $('cue-add').disabled, hint: $('cue-hint').textContent, driven: document.querySelector('.view-panel').classList.contains('is-driven')}`);
  check('Templates are read-only and View is marked as driven in Cues mode', r.add && /read-only/.test(r.hint) && r.driven, JSON.stringify(r));
  r = await ev(`const el=$('speed-number'); el.value='1.5'; el.dispatchEvent(new Event('input')); return {mode: controlMode, following: !!attachedPreset, speed: p.speed, status: $('status').textContent}`);
  check('Editing View in Cues mode switches to Manual', r.mode === 'manual' && !r.following && r.speed === 1.5 && /Switched to Manual/.test(r.status), JSON.stringify(r));
  r = await ev(`pause(); $('preset-new').click(); const n1=customPresets.length; $('cue-time').value='3'; $('cue-label').value='Mid'; $('cue-add').click(); const cues=selectedPreset().cues.length; $('cue-label').value='Mid edited'; $('cue-save').click(); const lbl=selectedPreset().cues[selectedCue].label; ${settle(500)} const stored=JSON.parse(localStorage.getItem(VideoState.key(currentVideoId))); $('cue-remove').click(); const after=selectedPreset().cues.length; return {n1,cues,lbl,storedCues:stored.presets[0].cues.length,after, kind: $('preset-kind').textContent}`);
  check('New timeline / add / update / remove cue, saved with the video', r.n1 === 1 && r.cues === 2 && r.lbl === 'Mid edited' && r.storedCues === 2 && r.after === 1 && r.kind === 'Saved with this video', JSON.stringify(r));
  r = await ev(`${mode('cues')} const add=$('cue-add').disabled, hint=$('cue-hint').textContent; ${mode('manual')} return {add, hint, addManual: $('cue-add').disabled}`);
  check('Adding cues needs Manual mode', r.add && /Switch Control to Manual/.test(r.hint) && !r.addManual, JSON.stringify(r));
  r = await ev(`$('cue-time').value='0'; $('cue-label').value='dup'; $('cue-add').click(); return $('status').textContent`);
  check('Rejects duplicate cue time', /same position/.test(r), r);
  r = await ev(`$('preset-select').value='builtin-detail'; $('preset-select').onchange(); $('preset-duplicate').click(); return {name: selectedPreset().name, builtin: selectedPreset().builtin, n: customPresets.length}`);
  check('Duplicate a template', r.builtin === false && r.n === 2 && /copy$/.test(r.name), JSON.stringify(r));
  r = await ev(`window.confirm=()=>true; $('preset-delete').click(); return {n: customPresets.length}`);
  check('Delete a timeline', r.n === 1, JSON.stringify(r));
  r = await ev(`const after=$('preset-select').value; $('preset-select').value='builtin-pace'; $('preset-select').onchange(); const out=ScheduleExport.csv(PresetModel, selectedPreset(), duration).split('\\r\\n'); return {rows: out.length, afterDelete: after}`);
  check('After deleting, no timeline is selected; CSV export generates rows', r.afterDelete === '' && r.rows > 50, JSON.stringify(r));
  const pick = files => `const dt=new DataTransfer(); for (const f of [${files}]) dt.items.add(f); $('file').files=dt.files; await $('file').onchange();`;
  r = await ev(`const b=builtInPresets[0]; ${pick(`new File([JSON.stringify({kind:'stickies-preset',version:1,preset:b})],'p.json')`)} return {n: customPresets.length, status: $('status').textContent}`);
  check('Import a timeline JSON', r.n === 2 && /Choose Cues to follow it/.test(r.status), JSON.stringify(r));
  r = await ev(`${pick(`new File([JSON.stringify({version:1,parameters:{zoom:2.5,x:30}})],'p.json')`)} return {zoom: p.zoom, x: p.x, status: $('status').textContent}`);
  check('Import a parameters JSON', r.zoom === 2.5 && r.x === 30, JSON.stringify(r));
  r = await ev(`await scrubTo(4); return {t: time, mode: controlMode, zoom: p.zoom}`);
  check('Timeline scrubbing only moves the playhead', Math.abs(r.t - 4) < 0.05 && r.mode === 'manual' && r.zoom === 2.5, JSON.stringify(r));
  r = await ev(`$('preset-select').value='builtin-bold'; $('preset-select').onchange(); document.querySelectorAll('.cue-row')[1].click(); ${settle(400)} return {zoom: p.zoom, t: time, expected: 0.28*duration, status: $('status').textContent}`);
  check('Clicking a cue in Manual loads it into View', r.zoom === 2.8 && Math.abs(r.t - r.expected) < 0.05 && /loaded into View/.test(r.status), JSON.stringify(r));
  r = await ev(`$('export').click(); const open=$('export-dialog').open, name=$('export-video-name').textContent, timeline=$('export-timeline-name').textContent; $('export-dialog').close(); return {open, name, timeline}`);
  check('Export opens one dialog for video, CSV and JSON', r.open && r.name === 'sample.mov' && r.timeline === 'Motion study', JSON.stringify(r));
  await ev(`$('reset').click()`);

  // 7. Live mode
  await ev(`${mode('live')}`);
  await sleep(500);
  for (let i = 1; i <= 15; i++) { await post({ seq: i, zoom: 2.5, speed: 0.5, x: 30, y: 40 }); await sleep(33); }
  await sleep(300);
  r = await ev(`return {zoom:p.zoom, speed:p.speed, badge:$('control-state').textContent, x:p.x, y:p.y, details: !$('live-details').hidden}`);
  check('Live mode drives speed, zoom and focus', Math.abs(r.zoom - 2.5) < 0.05 && Math.abs(r.speed - 0.5) < 0.02 && Math.abs(r.x - 30) < 0.5 && Math.abs(r.y - 40) < 0.5 && r.badge === 'Live' && r.details, JSON.stringify(r));
  r = await ev(`await scrubTo(2); document.querySelectorAll('.cue-row')[2].click(); ${settle(300)} return {mode: controlMode}`);
  check('Scrubbing and cue clicks keep Live mode', r.mode === 'live', JSON.stringify(r));
  await ev(`document.querySelector('[data-quick-key=zoom][data-quick-value="1"]').click()`);
  await post({ seq: 99, zoom: 4 }); await sleep(400);
  r = await ev(`return {zoom:p.zoom, mode: controlMode, enabled: liveEnabled}`);
  check('Editing View in Live mode switches to Manual and stops following', r.zoom === 1 && r.mode === 'manual' && !r.enabled, JSON.stringify(r));
  await ev(`${mode('live')}`); await sleep(400);
  await post({ seq: 100, zoom: 2 }); await sleep(50); await post({ seq: 50, zoom: 3 }); await sleep(100);
  r = await ev(`return liveChannel.stats(performance.now()).dropped`);
  check('Out-of-order seq dropped', r >= 1, 'dropped=' + r);
  await sleep(1800);
  r = await ev(`return {badge:$('control-state').textContent}`);
  check('Live goes Stale after 1 s', r.badge === 'Stale', JSON.stringify(r));
  r = await ev(`StickiesLive.disable(); return {mode: controlMode, details: $('live-details').hidden}`);
  check('StickiesLive.disable() returns to Manual', r.mode === 'manual' && r.details, JSON.stringify(r));
  await ev(`$('reset').click()`);

  // 7a. Live mode follows a position (`time`, e.g. a learner tracked by stickies_bridge)
  await ev(`await seekTo(0); ${mode('live')}`);
  await sleep(400);
  // Without live input, Play in Live mode is refused with a reason.
  r = await ev(`$('play').click(); ${settle(300)} return {playing, paused: video.paused, status: $('status').textContent, tone: document.querySelector('.status-dot').dataset.tone}`);
  check('Play in Live mode without live input is refused with an error', !r.playing && r.paused && /no live input is arriving/.test(r.status) && r.tone === 'error', JSON.stringify(r));
  let sentAt = Date.now();
  for (let i = 0; i < 5; i++) { await post({ seq: 190 + i, time: 3 + (Date.now() - sentAt) / 1000, speed: 1 }); await sleep(33); }
  await ev(`await play()`);
  for (let i = 0; i < 40; i++) { await post({ seq: 200 + i, time: 3 + (Date.now() - sentAt) / 1000, speed: 1 }); await sleep(33); }
  r = await ev(`return {now: video.currentTime, rate: video.playbackRate, follow: $('live-follow').textContent, playing}`);
  let expected = 3 + (Date.now() - sentAt) / 1000;
  check('Live jumps to a far-off position and then follows it', r.playing && Math.abs(r.now - expected) < 0.35 && /s$/.test(r.follow), JSON.stringify({ ...r, expected }));
  for (let i = 0; i < 10; i++) { await post({ seq: 300 + i, time: 0.5 + 3 + (Date.now() - sentAt) / 1000, speed: 1 }); await sleep(33); }
  r = await ev(`return {rate: video.playbackRate}`);
  check('Live plays faster to catch up a position just ahead', r.rate > 1.05 && r.rate <= 4, JSON.stringify(r));
  r = await ev(`StickiesLive.disable(); await new Promise(r => setTimeout(r, 50)); const rate = video.playbackRate; pause(); return {rate, speed: p.speed, follow: $('live-follow').textContent}`);
  check('Leaving Live restores the View speed', Math.abs(r.rate - r.speed) < 0.01 && r.follow === '—', JSON.stringify(r));
  await ev(`$('reset').click(); await seekTo(0)`);

  // 7b. Live values meant for another video are not applied to the open one
  r = await ev(`${mode('live')} ${settle(200)}
    for (let i = 0; i < 5; i++) { StickiesLive.push({ zoom: 3.5, video: 'curls.mp4' }); ${settle(30)} }
    ${settle(300)} const other = {zoom: p.zoom, badge: $('control-state').textContent, status: $('status').textContent};
    for (let i = 0; i < 5; i++) { StickiesLive.push({ zoom: 2.5, video: 'videos/sample.mov', source: 'hmm · test-session' }); ${settle(30)} }
    ${settle(400)} const own = {zoom: p.zoom, badge: $('control-state').textContent, source: $('live-source').textContent};
    liveVideoChanged(); const cleared = liveChannel.stats(performance.now()).target;
    return {other, own, cleared}`);
  check('Live ignores values sent for another video and says so', Math.abs(r.other.zoom - 1) < 1e-6 && r.other.badge === 'Other video' && /is for "curls.mp4"/.test(r.other.status), JSON.stringify(r));
  check('Live applies values sent for the open video', Math.abs(r.own.zoom - 2.5) < 0.05 && r.own.badge === 'Live', JSON.stringify(r));
  check('The Live panel shows which source drives the video', r.own.source === 'hmm · test-session', JSON.stringify(r));
  check('Opening another video drops the previous live values', r.cleared === null, JSON.stringify(r));
  await ev(`StickiesLive.disable(); $('reset').click();`);

  // 7b. Rounding and zoom animation order
  r = await ev(`return {a: floorTo(10.0167, 2), b: floorTo(7.7, 2), c: floorTo(5, 1), out: +$('out').value, duration}`);
  check('Times shown in fields round down', r.a === '10.01' && r.b === '7.70' && r.c === '5.0' && r.out <= r.duration, JSON.stringify(r));
  r = await ev(`const s=document.querySelector('[data-key=start]'), e=document.querySelector('[data-key=end]'); s.value='5'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); const a={start:p.start,end:p.end}; e.value='2'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); const b={start:p.start,end:p.end}; $('reset').click(); return {a,b}`);
  check('Zoom animation keeps End after Start', r.a.end > r.a.start && r.b.end > r.b.start && r.b.end === 2, JSON.stringify(r));

  // 8. Import JSON: seconds-based cues, the "video" field, and JSON + video selected together
  const example = JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, 'examples', 'biceps-curl.json'), 'utf8')), video: 'videos/sample.mov' });
  const clip = `new File([await (await fetch('videos/sample.mov')).blob()], 'my-clip.mov', {type:'video/quicktime'})`;
  r = await ev(`await loadFile(${clip}); const before=sourceName; ${pick(`new File([${JSON.stringify(example)}], 'biceps-curl.json')`)} return {before, src: video.currentSrc.split('/').pop(), name: selectedPreset().name, times: selectedPreset().cues.map(c=>+(c.at*duration).toFixed(2))}`);
  check('Import JSON loads the video named by a served path', r.before === 'my-clip.mov' && r.src === 'sample.mov' && r.name === 'Biceps curl walkthrough', JSON.stringify(r));
  check('Cue times in seconds land at those seconds', JSON.stringify(r.times) === '[0,2,4.5,6.5]', JSON.stringify(r.times));
  const named = JSON.stringify({ kind: 'stickies-preset', version: 1, video: '/Users/someone/Videos/my-clip.mov', preset: { name: 'Named', cues: [{ time: 0, label: 'A', parameters: {} }, { time: 3, label: 'B', parameters: { zoom: 2 } }] } });
  r = await ev(`${pick(`new File([${JSON.stringify(named)}], 'named.json')`)} return {status: $('status').textContent, name: selectedPreset().name}`);
  check('A local video path asks for the video to be selected too', /select the JSON file and that video together/.test(r.status) && r.name !== 'Named', r.status);
  r = await ev(`${pick(`new File([${JSON.stringify(named)}], 'named.json'), ${clip}`)} return {src: sourceName, name: selectedPreset().name}`);
  check('JSON and video selected together open together', r.src === 'my-clip.mov' && r.name === 'Named', JSON.stringify(r));
  const late = JSON.stringify({ kind: 'stickies-preset', version: 1, preset: { name: 'Late', cues: [{ time: 0, label: 'A', parameters: {} }, { time: 30, label: 'B', parameters: {} }] } });
  r = await ev(`${pick(`new File([${JSON.stringify(late)}], 'late.json')`)} return $('status').textContent`);
  check('A cue past the end of the video is reported', /Cue 2 is at 30 s, but the video is only 7.70 s long/.test(r), r);
  r = await ev(`${pick(`new File(['{"a":'], 'broken.json')`)} return $('status').textContent`);
  check('Broken JSON is reported', /broken.json is not valid JSON/.test(r), r);
  r = await ev(`const saved=window.download; let out; window.download=async (blob,name)=>{out={name, data: JSON.parse(await blob.text())}}; exportPresetJson('x.json'); ${settle(100)} window.download=saved; return out`);
  check('Exported timeline JSON uses seconds and names its video in the folder', r.data.video === 'videos/my-clip.mov' && r.data.preset.cues[1].time === 3 && !('at' in r.data.preset.cues[1]), JSON.stringify(r.data));

  // 9. Every video keeps its own parameters, cue timelines and export range
  const vid = name => `new File([await (await fetch('videos/sample.mov')).blob()], '${name}', {type:'video/quicktime'})`;
  const openNamed = name => `await openLibraryVideo(libraryVideos.find(v=>v.name==='${name}').id); for (let i=0; i<100 && video.readyState < 1; i++) ${settle(30)}`;
  r = await ev(`${pick(`${vid('video-a.mov')}, ${vid('video-b.mov')}`)} ${openNamed('video-a.mov')} applyManual({zoom: 2, x: 30}); $('preset-new').click(); $('preset-name').value='Only A'; $('preset-name').dispatchEvent(new Event('input')); $('out').value='3'; $('out').dispatchEvent(new Event('change')); ${settle(500)} ${openNamed('video-b.mov')} return {zoom: p.zoom, x: p.x, names: customPresets.map(p=>p.name), selected: $('preset-select').value, out: +$('out').value, duration}`);
  check('A newly opened video starts empty: no timeline, neutral View', r.zoom === 1 && r.x === 50 && !r.names.includes('Only A') && r.selected === '' && Math.abs(r.out - r.duration) < 0.02, JSON.stringify(r));
  r = await ev(`applyManual({speed: 0.5}); ${settle(500)} ${openNamed('video-a.mov')} const a={zoom: p.zoom, x: p.x, speed: p.speed, names: customPresets.map(p=>p.name), selected: selectedPreset().name, out: +$('out').value}; ${openNamed('video-b.mov')} return {a, bSpeed: p.speed, bZoom: p.zoom}`);
  check("Switching back restores each video's own settings", r.a.zoom === 2 && r.a.x === 30 && r.a.speed === 1 && r.a.names.includes('Only A') && r.a.selected === 'Only A' && r.a.out === 3 && r.bSpeed === 0.5 && r.bZoom === 1, JSON.stringify(r));
  await send('Page.reload'); await sleep(3000);
  r = await ev(`${openNamed('video-a.mov')} return {zoom: p.zoom, selected: selectedPreset().name}`);
  check('Per-video settings survive a reload', r.zoom === 2 && r.selected === 'Only A', JSON.stringify(r));
  r = await ev(`window.confirm=()=>true; const id=libraryVideos.find(v=>v.name==='video-a.mov').id; await removeLibraryVideo(id); ${settle(600)} return {stored: localStorage.getItem(VideoState.key(id)), current: currentVideoId, removed: id}`);
  check('Removing a video also removes its saved settings and its file', r.stored === null && r.current && r.current !== r.removed && !existsSync(join(videosDir, 'video-a.mov')), JSON.stringify(r));
  await ev(`for (let i=0; i<100 && video.readyState < 2; i++) ${settle(50)}`);

  // 6d2. Imported videos are files in the videos folder; videos from the old browser storage move there
  r = await ev(`return {names: libraryVideos.map(v=>v.name), urls: libraryVideos.map(v=>v.url)}`);
  check('Imported videos are saved as files in the videos folder', r.names.includes('my-clip.mov') && existsSync(join(videosDir, 'my-clip.mov')) && r.urls.includes('videos/my-clip.mov'), JSON.stringify(r));
  await ev(`const blob = await (await fetch('videos/sample.mov')).blob();
    const file = new File([blob], 'old-browser-video.mov', {type: 'video/quicktime'});
    await new Promise((resolve, reject) => { const req = indexedDB.open('stickies-video-library', 1); req.onupgradeneeded = () => req.result.createObjectStore('videos', {keyPath: 'id'}); req.onsuccess = () => { const tx = req.result.transaction('videos', 'readwrite'); tx.objectStore('videos').put({id: 'video-old1', name: file.name, size: file.size, addedAt: 1, duration: 7.7, thumb: '', blob: file}); tx.oncomplete = () => { req.result.close(); resolve(); }; tx.onerror = reject; }; req.onerror = reject; });
    localStorage.setItem(VideoState.key('video-old1'), JSON.stringify({version: 1, params: {...PresetModel.base, zoom: 3}, presets: [], selectedPresetId: 'builtin-bold', range: null}));
    localStorage.setItem('stickies.library.active', 'video-old1');`);
  await send('Page.reload'); await sleep(4000);
  r = await ev(`const dbs = (await indexedDB.databases()).map(d => d.name); return {source: sourceName, id: currentVideoId, zoom: p.zoom, selected: $('preset-select').value, dbs, oldKey: localStorage.getItem(VideoState.key('video-old1')), status: $('status').textContent}`);
  check('Videos from the old browser storage move into the folder with their settings', existsSync(join(videosDir, 'old-browser-video.mov')) && r.id === 'file:old-browser-video.mov' && r.zoom === 3 && r.oldKey === null && !r.dbs.includes('stickies-video-library'), JSON.stringify(r));
  check('A template auto-selected by the old version is not applied', r.selected === '', JSON.stringify(r));
  await ev(`await openLibraryVideo('file:sample.mov'); for (let i=0; i<100 && video.readyState < 2; i++) await new Promise(r=>setTimeout(r,50))`);

  // 6e. Video library
  const blobOf = name => `new File([await (await fetch('videos/sample.mov')).blob()], '${name}', {type:'video/quicktime'})`;
  r = await ev(`return {rows: [...document.querySelectorAll('.library-item')].map(li => li.querySelector('.library-name').textContent), current: document.querySelector('.library-item[aria-current=true] .library-name')?.textContent}`);
  check('Library lists the videos folder, with no built-in example', r.rows.includes('sample.mov') && !r.rows.includes('Exercise example'), JSON.stringify(r));
  r = await ev(`const dt=new DataTransfer(); dt.items.add(${blobOf('first.mov')}); dt.items.add(${blobOf('second.mov')}); $('file').files=dt.files; await $('file').onchange(); return {names: libraryVideos.map(v=>v.name), source: sourceName, current: document.querySelector('.library-item[aria-current=true] .library-name')?.textContent, thumbs: libraryVideos.filter(v=>v.thumb.startsWith('data:image')).length, duration: libraryVideos[0].duration}`);
  check('Importing several videos adds them all and opens the first', r.names.includes('first.mov') && r.names.includes('second.mov') && r.source === 'first.mov' && r.current === 'first.mov', JSON.stringify(r));
  check('Library entries get a thumbnail and duration', r.thumbs >= 2 && Math.abs(r.duration - 7.7) < 0.1, JSON.stringify(r));
  r = await ev(`const row=[...document.querySelectorAll('.library-item')].find(li=>li.textContent.includes('second.mov')); row.querySelector('.library-open').click(); await new Promise(r=>setTimeout(r,800)); return {source: sourceName, current: document.querySelector('.library-item[aria-current=true] .library-name')?.textContent, ready: video.readyState}`);
  check('Clicking a library entry switches video', r.source === 'second.mov' && r.current === 'second.mov' && r.ready >= 1, JSON.stringify(r));
  await send('Page.reload'); await sleep(3000);
  r = await ev(`return {names: libraryVideos.map(v=>v.name), source: sourceName}`);
  check('Library and last video survive a reload', r.names.includes('first.mov') && r.names.includes('second.mov') && r.source === 'second.mov', JSON.stringify(r));
  const byName = JSON.stringify({ kind: 'stickies-preset', version: 1, video: 'first.mov', preset: { name: 'By name', cues: [{ time: 0, label: 'A', parameters: {} }] } });
  r = await ev(`${pick(`new File([${JSON.stringify(byName)}], 'by-name.json')`)} return {source: sourceName, name: selectedPreset().name}`);
  check('A JSON naming a library video opens it', r.source === 'first.mov' && r.name === 'By name', JSON.stringify(r));
  // A video whose name holds # or %: its exported timeline must import again.
  r = await ev(`${pick(`new File([await (await fetch('videos/sample.mov')).blob()], 'clip #1 50%.mov', {type:'video/quicktime'})`)} ${settle(300)} return {id: currentVideoId, ready: video.readyState}`);
  const oddOpened = JSON.stringify(r);
  r = await ev(`window.oddFile = PresetModel.toFile({name: 'Odd name', cues: [{at: 0, label: 'A', parameters: PresetModel.base}]}, duration, currentVideoRef()); await openLibraryVideo('file:sample.mov'); ${settle(300)} return {ref: oddFile.video, id: currentVideoId}`);
  const oddRef = r.ref;
  r = await ev(`${pick(`new File([JSON.stringify(oddFile)], 'odd.json')`)} ${settle(300)} return {id: currentVideoId, ready: video.readyState, name: selectedPreset()?.name, status: $('status').textContent}`);
  check('A timeline exported from a video named with # or % imports again', oddRef === 'videos/clip #1 50%.mov' && r.id === 'file:clip #1 50%.mov' && r.ready >= 1 && r.name === 'Odd name', JSON.stringify({ oddOpened, oddRef, ...r }));
  // Leave the library as the next checks expect it: the odd clip gone, first.mov open.
  await ev(`window.confirm=()=>true; await removeLibraryVideo('file:clip #1 50%.mov'); await openLibraryVideo('file:first.mov'); ${settle(300)}`);
  r = await ev(`window.confirm=()=>true; const id=currentVideoId; await removeLibraryVideo(id); await new Promise(r=>setTimeout(r,500)); return {names: libraryVideos.map(v=>v.name), source: sourceName, current: currentVideoId}`);
  check('Removing the open video opens another library video', !r.names.includes('first.mov') && r.current && r.current !== 'file:first.mov', JSON.stringify(r));
  r = await ev(`window.confirm=()=>true; $('library-clear').click(); await new Promise(r=>setTimeout(r,600)); const stored = (await (await fetch('/api/videos')).json()).videos; return {names: libraryVideos.map(v=>v.name), stored: stored.length, rows: document.querySelectorAll('.library-item').length, clearDisabled: $('library-clear').disabled, current: currentVideoId, emptyShown: !$('viewer-empty').hidden, source: $('source').textContent, hint: !$('library-empty').hidden}`);
  check('Clear empties the library and its storage', r.names.length === 0 && r.stored === 0 && r.rows === 0 && r.clearDisabled && r.hint, JSON.stringify(r));
  check('With no videos, the viewer says so', r.current === null && r.emptyShown && r.source === 'No video', JSON.stringify(r));
  r = await ev(`$('play').click(); ${settle(200)} const playStatus = $('status').textContent; $('export').click(); $('export-start').click(); ${settle(200)} return {playing, playStatus, exportStatus: $('status').textContent, newDisabled: $('preset-new').disabled}`);
  check('With no video, Play, Export and New timeline explain or wait', !r.playing && /no video is open/.test(r.playStatus) && /no video is open/.test(r.exportStatus) && r.newDisabled, JSON.stringify(r));
  r = await ev(`$('library-toggle').click(); const hidden=getComputedStyle(document.querySelector('.library')).display==='none'; const saved=localStorage.getItem('stickies.library.collapsed'); $('library-toggle').click(); return {hidden, saved, shown: getComputedStyle(document.querySelector('.library')).display!=='none'}`);
  check('Library sidebar can be hidden and shown', r.hidden && r.saved === '1' && r.shown, JSON.stringify(r));
  // The export checks need a video again: put the test video back in the folder and reload.
  addSample();
  await send('Page.reload'); await sleep(3000);
  await ev(`for (let i=0; i<100 && video.readyState < 2; i++) await new Promise(r=>setTimeout(r,50))`);

  // 7. Video export (short range), capture download
  r = await ev(`window.__dl=null; window.download=(blob,name)=>{window.__dl={size:blob.size,type:blob.type,name}}; $('in').value='0'; $('out').value='1.5'; $('export').click(); $('export-start').click(); await new Promise(r=>setTimeout(r,500)); const rec=recording; for (let i=0; i<100 && (recording || !window.__dl); i++) await new Promise(r=>setTimeout(r,100)); await new Promise(r=>setTimeout(r,300)); return {rec, dl: window.__dl, status:$('status').textContent, enabled: !$('preset-new').disabled && !$('play').disabled, label: $('export').textContent.trim()}`);
  check('Video export produces a file', r.rec && r.dl && r.dl.size > 1000, JSON.stringify(r));
  check('UI unlocked after export', r.enabled && r.label === 'Export', JSON.stringify(r));

  // 10. Regression: clicking the canvas during export must not change what drives the view
  r = await ev(`for (let i=0; i<100 && recording; i++) await new Promise(r=>setTimeout(r,100)); $('in').value='0'; $('out').value='3'; $('preset-select').value='builtin-bold'; $('preset-select').onchange(); ${mode('cues')} $('export').click(); $('export-start').click(); await new Promise(r=>setTimeout(r,600)); const before=controlMode; const c=canvas.getBoundingClientRect(); canvas.dispatchEvent(new PointerEvent('pointerdown',{clientX:c.left+10,clientY:c.top+10,pointerId:1,bubbles:true})); const after=controlMode; finishExport(true); await new Promise(r=>setTimeout(r,500)); ${mode('manual')} return {before, after}`);
  check('Canvas click during export keeps Cues mode', r.before === 'cues' && r.after === 'cues', JSON.stringify(r));

  // 11. Regression: one damaged saved timeline must not erase the others
  const goodCount = await ev(`$('preset-new').click(); await new Promise(r=>setTimeout(r,500)); const key=VideoState.key(currentVideoId); const data=JSON.parse(localStorage.getItem(key)); data.presets.push({name:'', cues:[]}); localStorage.setItem(key, JSON.stringify(data)); return data.presets.length - 1`);
  await send('Page.reload'); await sleep(3000);
  r = await ev(`const key=VideoState.key(currentVideoId); const n0=customPresets.length; const status=$('status').textContent; const backup=!!localStorage.getItem(key+'.backup'); $('preset-new').click(); await new Promise(r=>setTimeout(r,500)); return {loaded:n0, status, backup, storedAfterNew: JSON.parse(localStorage.getItem(key)).presets.length}`);
  check('A damaged timeline does not erase the others', r.loaded === goodCount && r.storedAfterNew === goodCount + 1 && r.backup, JSON.stringify(r));
  check('Damaged timelines are reported to the user', /could not be read/.test(r.status), r.status);

  // 11b. An old server without the videos folder: the user is told, and the warning stays visible
  const oldServer = await send('Page.addScriptToEvaluateOnNewDocument', { source: `const realFetch = window.fetch; window.fetch = (url, opts) => String(url).includes('/api/videos') ? Promise.resolve(new Response('', {status: 404})) : realFetch(url, opts);` });
  await send('Page.reload'); await sleep(3000);
  r = await ev(`const shownAtStart = !$('library-warning').hidden; const dt=new DataTransfer(); dt.items.add(new File([await (await fetch('videos/sample.mov')).blob()], 'not-saved.mov', {type:'video/quicktime'})); $('file').files=dt.files; await $('file').onchange(); for (let i=0; i<60 && video.readyState < 1; i++) await new Promise(r=>setTimeout(r,50)); await new Promise(r=>setTimeout(r,300)); return {shownAtStart, warning: !$('library-warning').hidden, text: $('library-warning').textContent, status: $('status').textContent, meta: [...document.querySelectorAll('.library-meta')].map(m=>m.textContent)}`);
  check('Without the videos folder, the library warns how to fix it', r.shownAtStart && r.warning && /Restart the tool/.test(r.text) && r.meta.some(m => /this session only/.test(m)), JSON.stringify(r));
  check('The not-saved warning is not replaced by "Video ready."', /could not be saved/.test(r.status), r.status);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: oldServer.result.identifier });

  // 12. If browser storage hangs, the editor still opens the library video
  const hang = await send('Page.addScriptToEvaluateOnNewDocument', { source: 'indexedDB.open = () => ({});' });
  await send('Page.reload'); await sleep(6000);
  r = await ev(`return {current: currentVideoId, ready: video.readyState, rows: document.querySelectorAll('.library-item').length, status: $('status').textContent}`);
  check('Hanging browser storage still opens the library video', r.current === 'file:sample.mov' && r.ready >= 1 && r.rows === 1, JSON.stringify(r));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hang.result.identifier });
} catch (e) {
  results.push('HARNESS ERROR ' + e.stack);
} finally {
  console.log(results.join('\n'));
  const unexpected = logs.filter(line => !/could not be read and were skipped|Video library unavailable|could not be moved yet|kept for this session only/.test(line));
  console.log('\nConsole errors/warnings:\n' + (unexpected.join('\n') || '(none)'));
  chrome.kill(); server.kill();
  setTimeout(() => {
    rmSync(profile, { recursive: true, force: true });
    rmSync(videosDir, { recursive: true, force: true });
  }, 500);
  const failed = results.filter(line => !line.startsWith('PASS')).length + unexpected.length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 600);
}
