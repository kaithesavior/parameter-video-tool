'use strict';
const $ = id => document.getElementById(id),
  canvas = $('canvas'),
  ctx = canvas.getContext('2d'),
  video = $('video');
const defaults = { ...PresetModel.base };
let p = { ...defaults },
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
// ----- Control mode ----------------------------------------------------------------------
// Exactly one source drives speed, zoom and focus:
//   manual  the View settings in the inspector
//   cues    the selected cue timeline (presets.js)
//   live    live input from POST /input or StickiesLive.push (live.js)
const CONTROL_MODES = new Set(['manual', 'cues', 'live']);
let controlMode = 'manual';
function setControlMode(mode, message) {
  if (!CONTROL_MODES.has(mode)) return;
  const changed = mode !== controlMode;
  controlMode = mode;
  for (const input of document.querySelectorAll('input[name="control-mode"]')) input.checked = input.value === mode;
  if (changed) {
    if (typeof cuesModeChanged === 'function') cuesModeChanged(mode);
    if (typeof liveModeChanged === 'function') liveModeChanged(mode);
  }
  paintControl();
  if (message) setStatus(message);
}
// Editing the view while cues or live input drive it hands control back to Manual, so the
// edit sticks instead of being overwritten on the next frame.
function takeManualControl() {
  if (controlMode !== 'manual')
    setControlMode('manual', `Switched to Manual: your edit replaced ${controlMode === 'cues' ? 'the cues' : 'live input'}.`);
}
const CONTROL_HINTS = {
  manual: 'Speed, zoom and focus come from View below.',
  cues: 'Playback follows the selected cue timeline. Editing View switches to Manual.',
  live: 'Speed, zoom and focus follow live input. Editing View switches to Manual.',
};
function controlState() {
  if (controlMode === 'live' && typeof liveStateLabel === 'function') return liveStateLabel(performance.now());
  if (controlMode === 'cues') return playing ? { label: 'Playing cues', tone: 'is-live' } : { label: 'Cues', tone: '' };
  return { label: 'Manual', tone: '' };
}
function paintControl() {
  const state = controlState();
  const badge = $('control-state');
  if (badge.textContent !== state.label) badge.textContent = state.label;
  badge.className = 'badge ' + state.tone;
  $('control-hint').textContent = CONTROL_HINTS[controlMode];
  $('live-details').hidden = controlMode !== 'live';
  document.querySelector('.view-panel').classList.toggle('is-driven', controlMode !== 'manual');
  if (typeof paintCueEditing === 'function') paintCueEditing();
}
for (const input of document.querySelectorAll('input[name="control-mode"]'))
  input.addEventListener('change', () => {
    if (input.checked) setControlMode(input.value);
  });
// The view can be edited unless an export is running or the original is being compared.
function viewEditable() {
  return !recording && !$('compare').checked;
}
function applyManual(patch) {
  if (recording) return;
  takeManualControl();
  Object.assign(p, patch);
  sync();
}
// Rounds down to a number of decimals, for times shown in fields that must not exceed the video.
function floorTo(value, decimals) {
  const scale = 10 ** decimals;
  return (Math.floor(value * scale + 1e-9) / scale).toFixed(decimals);
}
function videoAspect() {
  return video.videoWidth / video.videoHeight || 16 / 9;
}
// The video frame letterboxed inside a canvas of the given size.
function fitFrame(width, height) {
  const ratio = videoAspect(),
    frameWidth = Math.min(width, height * ratio),
    frameHeight = frameWidth / ratio;
  return {
    width: frameWidth,
    height: frameHeight,
    left: (width - frameWidth) / 2,
    top: (height - frameHeight) / 2,
  };
}
// Changing playbackRate on every frame causes audio glitches, so only real changes are applied.
// In Live mode with a followed position, live.js adjusts the rate to stay on it.
function applyPlaybackRate() {
  const rate = typeof liveFollowRate === 'function' ? liveFollowRate(p.speed) : p.speed;
  if (Math.abs(video.playbackRate - rate) > 0.004) video.playbackRate = rate;
}
document
  .querySelectorAll('[data-quick-key]')
  .forEach(
    button =>
      (button.onclick = () => applyManual({ [button.dataset.quickKey]: Number(button.dataset.quickValue) })),
  );
$('focus-center').onclick = () => applyManual({ x: 50, y: 50 });
function editFocus(event) {
  if (!viewEditable()) return;
  const map = $('focus-map'),
    rect = map.getBoundingClientRect(),
    frame = fitFrame(map.width, map.height);
  const x = ((((event.clientX - rect.left) / rect.width) * map.width - frame.left) / frame.width) * 100,
    y = ((((event.clientY - rect.top) / rect.height) * map.height - frame.top) / frame.height) * 100;
  applyManual({ x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) });
}
let focusDragging = false;
$('focus-map').onpointerdown = event => {
  if (!viewEditable()) return;
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
  return { manual: 'Manual', cues: 'Cues', live: 'Live' }[controlMode];
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
  applyPlaybackRate();
  // Manual values belong to the open video and are saved with it.
  if (controlMode === 'manual' && typeof saveVideoState === 'function') saveVideoState();
}
document.querySelectorAll('[data-key]').forEach(el =>
  el.addEventListener('input', () => {
    const key = el.dataset.key;
    if (el.type !== 'checkbox' && (el.value === '' || !Number.isFinite(el.valueAsNumber))) return;
    takeManualControl();
    p[key] = el.type === 'checkbox' ? el.checked : Math.min(+el.max, Math.max(+el.min, el.valueAsNumber));
    sync();
  }),
);
// The zoom animation must end after it starts. Checked when an edit is committed (change),
// not on every keystroke, so typing "12" into End does not trip over the intermediate "1".
const ANIMATION_GAP = 1,
  ANIMATION_MAX = 36000;
function keepAnimationOrdered(changed) {
  if (p.end > p.start) return;
  if (changed === 'start') {
    p.end = Math.min(ANIMATION_MAX, p.start + ANIMATION_GAP);
    if (p.end <= p.start) p.start = p.end - ANIMATION_GAP;
  } else {
    p.start = Math.max(0, p.end - ANIMATION_GAP);
  }
  sync();
  setStatus(
    `Zoom animation must end after it starts, so ${changed === 'start' ? 'End' : 'Start'} was moved to ${(changed === 'start' ? p.end : p.start).toFixed(1)} s.`,
    'warn',
  );
}
for (const key of ['start', 'end'])
  document
    .querySelector(`[data-key="${key}"]`)
    .addEventListener('change', () => keepAnimationOrdered(key));
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
function setSize() {
  const width = +$('resolution').value;
  canvas.width = width;
  canvas.height = Math.round(width / videoAspect());
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
function draw() {
  if (video.seeking) return;
  const { z, w, h, tx, ty } = geometry();
  ctx.resetTransform();
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(z, z);
  if (video.readyState >= 2) ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();
}
// The video element owns the clock; the end of the clip is handled by video.onended.
function advanceClock() {
  time = video.currentTime;
  if (recording && time >= exportEnd) finishExport();
}
function renderFrame(dtMs) {
  if (typeof presetFrame === 'function') presetFrame(time);
  if (typeof liveFrame === 'function') liveFrame(dtMs);
  draw();
  paintMetrics();
  if (typeof updateTimelineCursor === 'function') updateTimelineCursor();
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
    advanceClock();
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
  const button = $('play'),
    label = playing ? 'Pause' : 'Play';
  button.dataset.state = playing ? 'playing' : 'paused';
  button.setAttribute('aria-label', label);
  button.title = label + ' (Space)';
  paintControl();
}
async function play() {
  if (!videoOpen()) throw new Error('Cannot play: no video is open. Import a video first.');
  // Live mode follows live input; without any for this video there is nothing to play to.
  const liveProblem = controlMode === 'live' && typeof liveBlocker === 'function' ? liveBlocker() : '';
  if (liveProblem) throw new Error(liveProblem);
  if (time >= duration - 0.02) await seekTo(0);
  await video.play();
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
  if (Math.abs(video.currentTime - time) > 0.001)
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
  else play().catch(error => setStatus(error.message));
};
$('to-start').onclick = () => seekTo(0).catch(error => setStatus(error.message));
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
function loaded() {
  duration = video.duration;
  time = 0;
  $('in').value = 0;
  // Rounded down: rounding up (e.g. 10.0167 → 10.02) would put the default end past the
  // video and block the export.
  $('out').value = floorTo(duration, 2);
  setSize();
  updatePlay();
  $('viewer-empty').hidden = true;
  // Each video has its own parameters, cue timelines and export range (presets.js).
  if (typeof applyVideoState === 'function') applyVideoState();
}
// Name of the loaded video (the file name for imported files) and its video library id
// ('file:<name>' for the videos folder, 'session-…' for session-only videos, null for others).
let sourceName = '',
  currentVideoId = null,
  startupNotice = '';
function prepareSource(label, id = null) {
  pause();
  // Save the outgoing video's state before anything about the new one is set.
  if (typeof flushVideoState === 'function') flushVideoState();
  sourceGeneration++;
  sourceName = label;
  currentVideoId = id;
  // Live values belong to the video they were sent for (live.js).
  if (typeof liveVideoChanged === 'function') liveVideoChanged();
  if (typeof paintVideoLibrary === 'function') paintVideoLibrary();
  if (objectURL) {
    URL.revokeObjectURL(objectURL);
    objectURL = null;
  }
  video.onloadedmetadata = () => {
    if (!Number.isFinite(video.duration) || !video.videoWidth) {
      setStatus('Unsupported video. Please use MP4 or WebM.');
      return;
    }
    loaded();
    $('source').textContent = label + ' · ' + video.videoWidth + ' × ' + video.videoHeight;
    // A start-up warning (e.g. damaged saved presets) is shown instead of "Video ready."
    // so it is not replaced before anyone can read it.
    if (startupNotice) setStatus(startupNotice, 'warn');
    else setStatus('Video ready.');
    startupNotice = '';
  };
  video.onerror = () => {
    setStatus('Cannot decode this video. Use a browser-compatible MP4 (H.264) or WebM file.');
  };
  return sourceGeneration;
}
// Resolves once the video's metadata (duration, size) is known; rejects if it cannot be used.
// Listeners are added after the onloadedmetadata handler, so `duration` is already updated.
function videoReady(label) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', ready);
      video.removeEventListener('error', failed);
    };
    const ready = () => {
      cleanup();
      if (Number.isFinite(video.duration) && video.videoWidth) resolve();
      else reject(new Error(`"${label}" is not a supported video. Please use MP4 or WebM.`));
    };
    const failed = () => {
      cleanup();
      reject(new Error(`Could not load the video "${label}".`));
    };
    video.addEventListener('loadedmetadata', ready);
    video.addEventListener('error', failed);
  });
}
function loadFile(file, label = file?.name, id = null) {
  if (!file) return Promise.resolve();
  prepareSource(label, id);
  const ready = videoReady(label);
  objectURL = URL.createObjectURL(file);
  video.src = objectURL;
  return ready;
}
// Loads a video the server provides (a path such as videos/clip.mp4) or a full URL.
// The library id for a served path: a video in the videos folder, or none.
function videoIdForUrl(url) {
  const match = /^videos\/([^/]+)$/.exec(url);
  return match ? 'file:' + decodeURIComponent(match[1]) : null;
}
function loadVideoUrl(url, label = url, id = videoIdForUrl(url)) {
  prepareSource(label, id);
  const ready = videoReady(label);
  video.src = url;
  return ready;
}
// Whether a video is open. Browsers keep the old currentSrc after a video is unloaded, so the
// src attribute is what tells.
function videoOpen() {
  return video.hasAttribute('src');
}
// No video open: the library is empty, or the open video was removed. The viewer says so,
// and View and the cue timelines return to their empty state.
function unloadVideo() {
  prepareSource('', null);
  video.onloadedmetadata = video.onerror = null;
  video.removeAttribute('src');
  video.load();
  time = 0;
  $('source').textContent = 'No video';
  $('viewer-empty').hidden = false;
  if (typeof applyVideoState === 'function') applyVideoState();
  draw();
}
// How a preset file refers to the current video: the file name of an imported file,
// otherwise its path on this server (e.g. videos/clip.mp4) or its full URL.
function currentVideoRef() {
  if (objectURL) return sourceName;
  if (!videoOpen() || !video.currentSrc) return '';
  const url = new URL(video.currentSrc);
  return url.origin === location.origin ? decodeURIComponent(url.pathname.slice(1)) : url.href;
}
// Import video and the video library live in library.js.

$('resolution').onchange = setSize;
video.onended = () => {
  pause();
  if (recording) finishExport();
};
function pointer(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}
function sourcePoint(q, g) {
  return {
    x: Math.min(100, Math.max(0, ((q.x - g.tx) / g.z / g.w) * 100)),
    y: Math.min(100, Math.max(0, ((q.y - g.ty) / g.z / g.h) * 100)),
  };
}
canvas.onpointerdown = event => {
  if (!viewEditable()) return;
  takeManualControl();
  // The focus is set where the pointer is released, using the view at the time of the press.
  drag = { g: geometry() };
  canvas.setPointerCapture(event.pointerId);
};
canvas.onpointerup = event => {
  if (!drag) return;
  const point = sourcePoint(pointer(event), drag.g);
  p.x = point.x;
  p.y = point.y;
  drag = null;
  sync();
};
canvas.onpointercancel = () => {
  drag = null;
};

$('reset').onclick = () => {
  takeManualControl();
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
// Applies a parameters file: {version: 1, parameters: {speed, zoom, x, y, …}}.
function importParameters(data) {
  if (data?.version !== 1 || !data.parameters || typeof data.parameters !== 'object')
    throw new Error('Unknown JSON format. Expected a preset ("kind": "stickies-preset") or parameters.');
  const next = PresetModel.parameters(data.parameters);
  takeManualControl();
  p = next;
  sync();
  setStatus('Parameters imported.');
}
const EXPORT_BUTTON_HTML = $('export').innerHTML;
function lock(yes) {
  document.querySelectorAll('button,input,select').forEach(el => (el.disabled = yes));
  $('export').disabled = false;
  if (yes) $('export').textContent = 'Cancel export';
  else $('export').innerHTML = EXPORT_BUTTON_HTML;
  if (yes) return;
  if (typeof paintVideoLibrary === 'function') paintVideoLibrary();
  if (typeof paintPreset === 'function') paintPreset();
  paintControl();
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
  if (!videoOpen()) return 'Cannot export: no video is open. Import a video first.';
  if (!window.MediaRecorder || !canvas.captureStream)
    return 'Video export is unavailable. Please use a recent version of Chrome or Edge.';
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > duration + 0.001)
    return 'Enter a valid export range: 0 ≤ start < end ≤ video duration.';
  if (video.readyState < 2) return 'Please wait for the video to finish loading.';
  if (p.animate && p.end <= p.start) return 'Zoom animation end time must be after its start time.';
  return '';
}
// The media element can only be attached to one audio graph, so it is built once.
async function ensureAudioGraph() {
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
    for (const track of audioDest.stream.getAudioTracks()) stream.addTrack(track.clone());
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
// ----- Export dialog ----------------------------------------------------------------------
// One place for every output of the open video: the edited video, its cue timeline (CSV or
// JSON) and the current view parameters. While a video export runs, the toolbar button cancels it.
function openExportDialog() {
  $('export-video-name').textContent = sourceName;
  const timeline = typeof selectedPreset === 'function' ? selectedPreset() : null;
  $('export-timeline-name').textContent = timeline ? timeline.name : 'none selected';
  $('export-csv').disabled = $('export-json').disabled = !timeline;
  $('export-dialog').showModal();
}
$('export').onclick = () => {
  if (recording) finishExport(true);
  else openExportDialog();
};
$('export-start').onclick = () => {
  $('export-dialog').close();
  void startExport();
};
$('export-params').onclick = () => {
  download(
    new Blob([JSON.stringify({ version: 1, parameters: p }, null, 2)], { type: 'application/json' }),
    'view-parameters.json',
  );
  setStatus('View parameters exported. Import restores them.');
};
// The export range belongs to the open video.
for (const id of ['in', 'out'])
  $(id).addEventListener('change', () => {
    if (typeof saveVideoState === 'function') saveVideoState();
  });
sync();
paintControl();
// library.js opens the first video (the last one watched, or the first in the library).
