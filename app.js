'use strict';
const $ = id => document.getElementById(id),
  canvas = $('canvas'),
  ctx = canvas.getContext('2d'),
  video = $('video');
const defaults = { ...PresetModel.base };
let p = { ...defaults },
  demo = true,
  playing = false,
  time = 0,
  duration = 8,
  last = 0,
  objectURL = null,
  recording = false,
  recorder = null,
  audioCtx = null,
  audioDest = null,
  audioNode = null,
  drag = null,
  selection = null,
  exportEnd = 0,
  exportCancelled = false,
  exportState = null;
let sourceGeneration = 0;
const primaryControls = [
  ['speed', 'Speed', 0.25, 3, 0.05, [0.25, 0.5, 1, 2]],
  ['zoom', 'Zoom', 1, 5, 0.05, [1, 1.5, 2, 3]],
];
for (const [key, label, min, max, step, stops] of primaryControls) {
  const section = document.createElement('section');
  section.className = 'parameter-block';
  const stopButtons = stops
    .map(
      value =>
        `<button type="button" data-quick-key="${key}" data-quick-value="${value}" aria-label="Set ${label.toLowerCase()} to ${value} times">${value}×</button>`,
    )
    .join('');
  section.innerHTML = `<div class="parameter-heading"><label for="${key}-number">${label}</label><div class="parameter-value"><input id="${key}-number" type="number" data-key="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label}"><span>×</span></div></div><input id="${key}" type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label} slider"><div class="parameter-stops">${stopButtons}</div>`;
  $('controls').append(section);
}
function applyManual(patch) {
  if (recording) return;
  if (typeof presetManualOverride === 'function') presetManualOverride();
  if (typeof liveManualOverride === 'function') liveManualOverride();
  Object.assign(p, patch);
  sync();
}
document
  .querySelectorAll('[data-quick-key]')
  .forEach(
    button =>
      (button.onclick = () => applyManual({ [button.dataset.quickKey]: Number(button.dataset.quickValue) })),
  );
$('focus-center').onclick = () => applyManual({ x: 50, y: 50 });
function editFocus(event) {
  if (recording || $('compare').checked) return;
  const map = $('focus-map'),
    rect = map.getBoundingClientRect(),
    ratio = demo ? 16 / 9 : video.videoWidth / video.videoHeight || 16 / 9,
    fw = Math.min(map.width, map.height * ratio),
    fh = fw / ratio,
    ox = (map.width - fw) / 2,
    oy = (map.height - fh) / 2;
  const x = ((((event.clientX - rect.left) / rect.width) * map.width - ox) / fw) * 100,
    y = ((((event.clientY - rect.top) / rect.height) * map.height - oy) / fh) * 100;
  applyManual({ x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) });
}
let focusDragging = false;
$('focus-map').onpointerdown = event => {
  if (recording || $('compare').checked) return;
  focusDragging = true;
  $('focus-map').setPointerCapture(event.pointerId);
  editFocus(event);
};
$('focus-map').onpointermove = event => {
  if (focusDragging) editFocus(event);
};
$('focus-map').onpointerup = () => {
  focusDragging = false;
};
$('focus-map').onpointercancel = () => {
  focusDragging = false;
};
const metricLabels = {
  speed: 'Playback speed',
  zoom: 'Current zoom',
  target: 'Target zoom',
  focus: 'Focus X / Y',
  position: 'Source time',
  animation: 'Zoom animation',
  output: 'Output resolution',
  range: 'Export range',
};
for (const [key, label] of Object.entries(metricLabels)) {
  const cell = document.createElement('div');
  cell.className = 'metric';
  const title = document.createElement('dt');
  title.textContent = label;
  const value = document.createElement('dd');
  value.id = 'metric-' + key;
  cell.append(title, value);
  $('live-metrics').append(cell);
}
function paintMetrics() {
  const raw = $('compare').checked,
    g = geometry();
  const values = {
    speed: p.speed.toFixed(2) + '×',
    zoom: g.z.toFixed(2) + '×',
    target: p.zoom.toFixed(2) + '×',
    focus: p.x.toFixed(1) + '% / ' + p.y.toFixed(1) + '%',
    position: time.toFixed(2) + ' / ' + duration.toFixed(2) + ' s',
    animation: p.animate ? '1 · ' + p.start.toFixed(2) + '–' + p.end.toFixed(2) + ' s' : '0 · Off',
    output: canvas.width + ' × ' + canvas.height + ' px',
    range: Number($('in').value).toFixed(2) + '–' + Number($('out').value).toFixed(2) + ' s',
  };
  for (const [key, value] of Object.entries(values)) {
    const node = $('metric-' + key);
    if (node.textContent !== value) node.textContent = value;
  }
  const mode = viewMode(raw);
  if ($('metrics-mode').textContent !== mode) $('metrics-mode').textContent = mode;
}
function viewMode(raw) {
  if (raw) return 'Original';
  if (typeof attachedPreset !== 'undefined' && attachedPreset) return 'Preset';
  return 'Manual';
}
function sync() {
  document.querySelectorAll('[data-key]').forEach(el => {
    const val = p[el.dataset.key];
    if (el.type === 'checkbox') el.checked = val;
    else el.value = typeof val === 'number' ? +val.toFixed(2) : val;
  });
  document
    .querySelectorAll('[data-quick-key]')
    .forEach(button =>
      button.setAttribute(
        'aria-pressed',
        String(Math.abs(p[button.dataset.quickKey] - Number(button.dataset.quickValue)) < 0.001),
      ),
    );
  video.playbackRate = p.speed;
  if (typeof paintSimulation === 'function' && !attachedPreset) paintSimulation(null);
}
document.querySelectorAll('[data-key]').forEach(el =>
  el.addEventListener('input', () => {
    const key = el.dataset.key;
    if (el.type === 'checkbox') p[key] = el.checked;
    else {
      if (el.value === '' || !Number.isFinite(el.valueAsNumber)) return;
      p[key] = Math.min(+el.max, Math.max(+el.min, el.valueAsNumber));
    }
    sync();
  }),
);
function setStatus(message, tone) {
  $('status').textContent = message;
  document.querySelector('.status-dot').dataset.tone =
    tone || (/fail|error|cannot|could not|unsupported|invalid|unavailable/i.test(message) ? 'error' : '');
}
window.addEventListener('error', event =>
  setStatus('Unexpected error: ' + (event.message || 'unknown'), 'error'),
);
window.addEventListener('unhandledrejection', event =>
  setStatus('Unexpected error: ' + (event.reason?.message || event.reason || 'unknown'), 'error'),
);
document.addEventListener('visibilitychange', () => {
  if (recording && document.hidden)
    setStatus(
      'Export continues, but browsers slow hidden tabs. Return to this tab to avoid dropped frames.',
      'warn',
    );
});
function fmt(t) {
  return `${Math.floor(t / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(t % 60)
    .toString()
    .padStart(2, '0')}`;
}
function setSize() {
  const w = +$('resolution').value,
    ratio = demo ? 16 / 9 : video.videoWidth / video.videoHeight;
  canvas.width = w;
  canvas.height = Math.round(w / ratio);
}
function zoomAt(t) {
  if (!p.animate) return p.zoom;
  let u = Math.max(0, Math.min(1, (t - p.start) / Math.max(0.01, p.end - p.start)));
  return 1 + (p.zoom - 1) * (u * u * (3 - 2 * u));
}
function geometry() {
  const z = $('compare').checked ? 1 : zoomAt(time),
    w = canvas.width,
    h = canvas.height;
  return {
    z,
    w,
    h,
    tx: Math.min(0, Math.max(w - w * z, w / 2 - (p.x / 100) * w * z)),
    ty: Math.min(0, Math.max(h - h * z, h / 2 - (p.y / 100) * h * z)),
  };
}
function demoDraw(t, w, h) {
  ctx.fillStyle = '#1c282b';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#344246';
  ctx.lineWidth = 1;
  for (let i = 0; i < w; i += w / 16) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, h);
    ctx.stroke();
  }
  for (let i = 0; i < h; i += h / 9) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(w, i);
    ctx.stroke();
  }
  ctx.fillStyle = '#c0baa8';
  ctx.fillRect(w * 0.12, h * 0.19, w * 0.76, h * 0.62);
  ctx.fillStyle = '#e5dfd0';
  ctx.fillRect(w * 0.15, h * 0.23, w * 0.7, h * 0.54);
  ctx.fillStyle = '#263a3b';
  ctx.fillRect(w * 0.19, h * 0.29, w * 0.29, h * 0.38);
  ctx.fillStyle = '#badc91';
  ctx.beginPath();
  ctx.arc(w * 0.335, h * 0.48, h * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#597a43';
  ctx.beginPath();
  ctx.arc(
    w * (0.335 + 0.045 * Math.sin(t * 1.2)),
    h * (0.48 + 0.025 * Math.cos(t)),
    h * 0.055,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.fillStyle = '#47574b';
  ctx.font = `600 ${w * 0.022}px sans-serif`;
  ctx.fillText('FORM / 028', w * 0.53, h * 0.36);
  ctx.font = `${w * 0.012}px sans-serif`;
  ctx.fillText('A study in light, form and motion.', w * 0.53, h * 0.42);
  ctx.fillStyle = '#a3aa96';
  for (let i = 0; i < 3; i++)
    ctx.fillRect(w * 0.53, h * (0.49 + i * 0.05), w * (0.22 - i * 0.025), h * 0.009);
  ctx.fillStyle = '#263a3b';
  ctx.fillRect(w * 0.53, h * 0.66, w * 0.13, h * 0.045);
  ctx.fillStyle = '#e5dfd0';
  ctx.font = `${w * 0.009}px sans-serif`;
  ctx.fillText('EXPLORE OBJECT', w * 0.542, h * 0.69);
}
function draw() {
  if (!demo && video.seeking) return;
  const g = geometry(),
    { z, w, h, tx, ty } = g;
  ctx.resetTransform();
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(z, z);
  if (demo) demoDraw(time, w, h);
  else if (video.readyState >= 2) ctx.drawImage(video, 0, 0, w, h);
  if (typeof drawMuscleHighlight === 'function') drawMuscleHighlight(ctx, w, h);
  ctx.restore();
}
// Moves the playhead: the demo clip runs on its own clock, real videos report theirs.
function advanceClock(dt) {
  if (!demo) {
    time = video.currentTime;
  } else if (playing) {
    time += dt * p.speed;
    if (time >= duration) {
      time = duration;
      if (recording) {
        finishExport();
      } else {
        playing = false;
        updatePlay();
      }
    }
  }
  if (recording && time >= exportEnd) finishExport();
}
function renderFrame(dtMs) {
  if (typeof presetFrame === 'function') presetFrame(time);
  if (typeof liveFrame === 'function') liveFrame(dtMs);
  if (typeof muscleFrame === 'function') muscleFrame(dtMs);
  draw();
  paintMetrics();
  if (typeof updateTimelineCursor === 'function') updateTimelineCursor();
  $('clock').value = `${fmt(time)} / ${fmt(duration)}`;
  $('seek').value = time;
}
// Render loop. The next frame is scheduled first and each frame is guarded, so one bad
// frame (decoder hiccup, bad input) is reported instead of freezing the editor.
let frameErrors = 0;
function tick(now) {
  requestAnimationFrame(tick);
  try {
    if (!last) last = now;
    const dtMs = Math.min(250, now - last);
    last = now;
    advanceClock(dtMs / 1000);
    renderFrame(dtMs);
    frameErrors = 0;
  } catch (error) {
    // Report once per streak rather than 60 times a second.
    if (frameErrors++ === 0) {
      console.error(error);
      setStatus('Rendering error: ' + error.message, 'error');
    }
  }
}
requestAnimationFrame(tick);
function updatePlay() {
  const b = $('play'),
    label = playing ? 'Pause' : 'Play';
  b.dataset.state = playing ? 'playing' : 'paused';
  b.setAttribute('aria-label', label);
  b.title = label + ' (Space)';
}
async function play() {
  if (time >= duration - 0.02) await seekTo(0);
  if (!demo) {
    await video.play();
  }
  playing = true;
  updatePlay();
}
function pause() {
  video.pause();
  playing = false;
  updatePlay();
}
async function seekTo(t) {
  time = Math.min(duration, Math.max(0, t));
  if (!demo && Math.abs(video.currentTime - time) > 0.001)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Video seeking timed out'));
      }, 8000);
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('seeked', done);
        video.removeEventListener('error', fail);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('Video seeking failed'));
      };
      video.addEventListener('seeked', done, { once: true });
      video.addEventListener('error', fail, { once: true });
      video.currentTime = time;
    });
  if (typeof presetFrame === 'function') presetFrame(time);
  draw();
}
$('play').onclick = () => {
  if (playing) pause();
  else play().catch(e => setStatus(e.message));
};
$('to-start').onclick = () => seekTo(0).catch(e => setStatus(e.message));
document.addEventListener('keydown', e => {
  if (
    e.code !== 'Space' ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    e.target.closest('input,select,textarea,button,summary,[role=button]') ||
    $('play').disabled
  )
    return;
  e.preventDefault();
  $('play').click();
});
$('seek').oninput = () => {
  time = +$('seek').value;
  if (!demo) video.currentTime = time;
};
function loaded() {
  duration = demo ? 8 : video.duration;
  time = 0;
  $('seek').max = duration;
  $('in').value = 0;
  $('out').value = duration.toFixed(2);
  setSize();
  updatePlay();
  if (typeof presetsMediaChanged === 'function') presetsMediaChanged();
}
function prepareSource(label) {
  pause();
  if (typeof stopPreset === 'function') stopPreset(false);
  sourceGeneration++;
  if (objectURL) {
    URL.revokeObjectURL(objectURL);
    objectURL = null;
  }
  demo = false;
  video.onloadedmetadata = () => {
    if (!Number.isFinite(video.duration) || !video.videoWidth) {
      setStatus('Unsupported video. Please use MP4 or WebM.');
      return;
    }
    loaded();
    $('source').textContent = label + ' · ' + video.videoWidth + ' × ' + video.videoHeight;
    setStatus('Video ready.');
  };
  video.onerror = () => {
    setStatus('Cannot decode this video. Use a browser-compatible MP4 (H.264) or WebM file.');
  };
  return sourceGeneration;
}
function loadFile(file) {
  if (!file) return;
  prepareSource(file.name);
  objectURL = URL.createObjectURL(file);
  video.src = objectURL;
}
function loadExample() {
  prepareSource('Exercise example');
  video.src = 'assets/biceps-source.mov';
}
$('open').onclick = () => $('file').click();
$('file').onchange = () => {
  loadFile($('file').files[0]);
  $('file').value = '';
};
$('demo').onclick = loadExample;

$('resolution').onchange = setSize;
video.onended = () => {
  pause();
  if (recording) finishExport();
};
video.onerror = () => setStatus('Could not read the video.');
function pointer(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}
function sourcePoint(q, g) {
  return {
    x: Math.min(100, Math.max(0, ((q.x - g.tx) / g.z / g.w) * 100)),
    y: Math.min(100, Math.max(0, ((q.y - g.ty) / g.z / g.h) * 100)),
  };
}
canvas.onpointerdown = e => {
  if (recording || $('compare').checked) return;
  drag = { point: pointer(e), g: geometry() };
  canvas.setPointerCapture(e.pointerId);
};
canvas.onpointerup = e => {
  if (!drag) return;
  const point = sourcePoint(pointer(e), drag.g);
  p.x = point.x;
  p.y = point.y;
  drag = null;
  sync();
};
canvas.onpointercancel = () => {
  drag = null;
};

$('reset').onclick = () => {
  p = { ...defaults };
  $('compare').checked = false;
  sync();
};
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('save').onclick = () =>
  download(
    new Blob([JSON.stringify({ version: 1, parameters: p }, null, 2)], { type: 'application/json' }),
    'focus-parameters.json',
  );
$('load').onclick = () => $('recipe').click();
$('recipe').onchange = async () => {
  try {
    const f = $('recipe').files[0];
    if (!f) return;
    const data = JSON.parse(await f.text());
    if (data.version !== 1 || !data.parameters || typeof data.parameters !== 'object')
      throw new Error('Invalid parameter format');
    const next = PresetModel.parameters(data.parameters);
    p = next;
    sync();
    setStatus('Parameters imported.');
  } catch (e) {
    setStatus('Import failed: ' + e.message);
  } finally {
    $('recipe').value = '';
  }
};
function lock(yes) {
  document.querySelectorAll('button,input,select').forEach(el => (el.disabled = yes));
  $('export').disabled = false;
  $('export').textContent = yes ? 'Cancel export' : 'Export video';
  if (!yes && typeof paintPreset === 'function') {
    paintPreset();
    paintSimulation(attachedPreset ? PresetModel.sample(attachedPreset, time, duration) : null);
  }
}
function finishExport(cancel = false) {
  if (!recording) return;
  exportCancelled = cancel;
  recording = false;
  pause();
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}
// Returns a reason the export cannot start, or an empty string when it can.
function exportBlocker(from, to) {
  if (!window.MediaRecorder || !canvas.captureStream)
    return 'Video export is unavailable. Please use a recent version of Chrome or Edge.';
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > duration + 0.001)
    return 'Enter a valid export range: 0 ≤ start < end ≤ video duration.';
  if (!demo && video.readyState < 2) return 'Please wait for the video to finish loading.';
  if (p.animate && p.end <= p.start) return 'Zoom animation end time must be after its start time.';
  return '';
}
// The media element can only be attached to one audio graph, so it is built once.
async function ensureAudioGraph() {
  if (demo) return;
  if (!audioCtx) {
    audioCtx = new AudioContext();
    audioNode = audioCtx.createMediaElementSource(video);
    audioDest = audioCtx.createMediaStreamDestination();
    audioNode.connect(audioDest);
    audioNode.connect(audioCtx.destination);
  }
  await audioCtx.resume();
}
function pickExportMime() {
  const mime = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('No supported video encoder is available in this browser');
  return mime;
}
async function finishRecording(stream, chunks, mime) {
  stream.getTracks().forEach(track => track.stop());
  lock(false);
  if (!exportCancelled && chunks.length) {
    download(new Blob(chunks, { type: mime }), `focus-export.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
    setStatus('Video exported.');
  } else if (exportCancelled) {
    setStatus('Export canceled.');
  } else {
    setStatus('Export failed: no video data was generated.');
  }
  $('compare').checked = exportState.compare;
  await seekTo(exportState.time).catch(error => setStatus(error.message));
}
function startRecorder(stream, mime) {
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
  const chunks = [];
  recorder.ondataavailable = event => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => finishRecording(stream, chunks, mime);
  recorder.onerror = () => {
    exportCancelled = true;
    finishExport(true);
    setStatus('Video encoding failed. Try a lower resolution.');
  };
  exportCancelled = false;
  recording = true;
  recorder.start(250);
}
async function startExport() {
  const from = +$('in').value,
    to = +$('out').value;
  const blocker = exportBlocker(from, to);
  if (blocker) {
    setStatus(blocker);
    return;
  }
  pause();
  exportState = { time, compare: $('compare').checked };
  $('compare').checked = false;
  lock(true);
  let stream;
  try {
    await ensureAudioGraph();
    await seekTo(from);
    if (typeof presetFrame === 'function') presetFrame(from);
    draw();
    stream = canvas.captureStream(30);
    if (!demo) for (const track of audioDest.stream.getAudioTracks()) stream.addTrack(track.clone());
    const mime = pickExportMime();
    exportEnd = to;
    startRecorder(stream, mime);
    await play();
    setStatus('Exporting. Keep this page visible. Click Cancel Export to stop.');
  } catch (error) {
    if (recording && recorder?.state !== 'inactive') {
      finishExport(true);
    } else {
      recording = false;
      stream?.getTracks().forEach(track => track.stop());
      lock(false);
      $('compare').checked = exportState.compare;
    }
    setStatus('Export failed: ' + error.message);
  }
}
$('export').onclick = () => {
  if (recording) finishExport(true);
  else void startExport();
};
sync();
loadExample();
