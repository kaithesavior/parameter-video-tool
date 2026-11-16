'use strict';
const PRESET_STORAGE = 'stickies.instruction-presets.v1';
function cue(at, label, patch) {
  return { at, label, parameters: { ...defaults, ...patch, animate: false } };
}
const builtInPresets = [
  {
    id: 'builtin-bold',
    name: 'Motion study',
    builtin: true,
    cues: [
      cue(0, 'Full view / normal speed', { zoom: 1, speed: 1 }),
      cue(0.28, 'Close inspection / 2.80x zoom at 0.30x speed', { x: 67, y: 56, zoom: 2.8, speed: 0.3 }),
      cue(0.55, 'Follow the movement / 2.40x zoom at 0.50x speed', { x: 69, y: 58, zoom: 2.4, speed: 0.5 }),
      cue(0.74, 'Fast replay / full view at 2.50x speed', { zoom: 1, speed: 2.5 }),
      cue(0.92, 'Return to normal speed', { zoom: 1, speed: 1 }),
    ],
  },
  {
    id: 'builtin-detail',
    name: 'Slow practice',
    builtin: true,
    cues: [
      cue(0, 'Full view', { zoom: 1, speed: 1 }),
      cue(0.2, 'Slow inspection', { x: 65, y: 54, zoom: 2, speed: 0.5 }),
      cue(0.65, 'Follow movement', { x: 69, y: 58, zoom: 2, speed: 0.75 }),
      cue(0.85, 'Full view', { zoom: 1, speed: 1 }),
    ],
  },
  {
    id: 'builtin-pace',
    name: 'Pace study',
    builtin: true,
    cues: [
      cue(0, 'Normal pace', { speed: 1 }),
      cue(0.2, 'Slow pace', { speed: 0.3 }),
      cue(0.5, 'Controlled pace', { speed: 0.75 }),
      cue(0.75, 'Fast pace', { speed: 2.5 }),
      cue(0.93, 'Normal pace', { speed: 1 }),
    ],
  },
];
let customPresets = [],
  attachedPreset = null,
  selectedCue = 0,
  lastCue = -1,
  lastSamplePaint = 0,
  presetStarting = false;
try {
  const stored = JSON.parse(localStorage.getItem(PRESET_STORAGE) || '[]');
  if (!Array.isArray(stored) || stored.length > 50) throw new Error('Invalid library');
  customPresets = stored.map((item, index) => {
    return { ...PresetModel.validate(item), id: 'custom-restored-' + index };
  });
} catch {
  setStatus('Saved presets could not be read. Built-in presets are available.');
}
function library() {
  return [...builtInPresets, ...customPresets];
}
function selectedPreset() {
  return library().find(item => item.id === $('preset-select').value) || builtInPresets[0];
}
function storePresets() {
  try {
    localStorage.setItem(PRESET_STORAGE, JSON.stringify(customPresets));
    return true;
  } catch {
    setStatus('Browser storage is unavailable. Export the preset JSON to keep a copy.');
    return false;
  }
}
function id() {
  return 'custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}
function paintLibrary(selected) {
  const select = $('preset-select');
  select.replaceChildren();
  for (const item of library()) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name + (item.builtin ? ' · built-in' : '');
    select.append(option);
  }
  select.value = selected || builtInPresets[0].id;
  paintPreset();
}
function paintPreset() {
  const preset = selectedPreset();
  selectedCue = Math.min(selectedCue, preset.cues.length - 1);
  $('preset-name').value = preset.name;
  $('preset-name').readOnly = !!preset.builtin;
  $('preset-kind').textContent = preset.builtin
    ? 'Built-in · duplicate to edit'
    : 'Custom · saved in this browser';
  $('cue-save').disabled = !!preset.builtin || recording;
  $('cue-add').disabled = !!preset.builtin || recording;
  $('cue-remove').disabled = !!preset.builtin || selectedCue === 0 || recording;
  $('preset-delete').disabled = !!preset.builtin || recording;
  $('cue-list').replaceChildren();
  preset.cues.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cue-row';
    row.dataset.index = index;
    row.setAttribute('aria-pressed', String(index === selectedCue));
    const at = document.createElement('span');
    at.className = 'cue-at';
    at.textContent = (item.at * duration).toFixed(2) + 's';
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(at, label);
    row.onclick = async () => {
      if (recording) return;
      stopPreset(false);
      pause();
      selectedCue = index;
      Object.assign(p, item.parameters);
      sync();
      fillCue();
      paintPreset();
      await seekTo(item.at * duration).catch(e => setStatus(e.message));
      setStatus('Cue loaded. Adjust the inspector, then use Update cue.');
    };
    $('cue-list').append(row);
  });
  fillCue();
  paintSchedule();
}
function fillCue() {
  const c = selectedPreset().cues[selectedCue];
  $('cue-time').value = (c.at * duration).toFixed(2);
  $('cue-time').max = duration.toFixed(6);
  $('cue-label').value = c.label;
}
function paintSimulation(sample) {
  $('sim-event').textContent = sample ? sample.label : 'No simulated event';
  $('preset-mode').textContent = presetModeLabel();
  $('preset-mode').classList.toggle('is-live', !!attachedPreset && playing);
  $('preset-stop').disabled = !attachedPreset || recording;
  document
    .querySelectorAll('.cue-row')
    .forEach(row => row.classList.toggle('is-active', !!sample && +row.dataset.index === sample.index));
  if (sample) $('preset-progress').value = sample.position;
  document
    .querySelectorAll('#parameter-schedule [data-cue]')
    .forEach(cell =>
      cell.classList.toggle('current-cue', !!sample && Number(cell.dataset.cue) === sample.index),
    );
}
function presetModeLabel() {
  if (!attachedPreset) return 'Manual';
  if (playing) return 'Running';
  return time >= duration - 0.02 ? 'Complete' : 'Paused';
}
function presetFrame(t) {
  if (!attachedPreset) return;
  const result = PresetModel.sample(attachedPreset, t, duration);
  Object.assign(p, result.parameters);
  video.playbackRate = p.speed;
  const now = performance.now();
  if (result.index !== lastCue || now - lastSamplePaint > 100) {
    sync();
    paintSimulation(result);
    lastSamplePaint = now;
    lastCue = result.index;
  }
}
function stopPreset(message = true) {
  attachedPreset = null;
  lastCue = -1;
  $('preset-progress').value = 0;
  paintSimulation(null);
  if (message) setStatus('Preset stopped. Current parameters are retained.');
}
function presetManualOverride() {
  if (attachedPreset) {
    stopPreset(false);
    setStatus('Simulation stopped: manual parameter override.');
  }
}
function presetsMediaChanged() {
  stopPreset(false);
  paintPreset();
}
async function replayPreset() {
  if (recording || presetStarting) return;
  if (!demo && video.readyState < 2) {
    const generation = sourceGeneration;
    presetStarting = true;
    setStatus('Preparing video for preset playback…');
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener('loadeddata', ready);
          video.removeEventListener('error', failed);
        };
        const ready = () => {
            cleanup();
            resolve();
          },
          failed = () => {
            cleanup();
            reject(new Error('Video could not be decoded.'));
          };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Video loading timed out.'));
        }, 8000);
        video.addEventListener('loadeddata', ready, { once: true });
        video.addEventListener('error', failed, { once: true });
      });
    } catch (e) {
      setStatus(e.message);
      return;
    } finally {
      presetStarting = false;
    }
    if (generation !== sourceGeneration) return;
  }
  pause();
  attachedPreset = structuredClone(selectedPreset());
  lastCue = -1;
  $('compare').checked = false;
  try {
    await seekTo(0);
    presetFrame(0);
    await play();
    paintSimulation(PresetModel.sample(attachedPreset, 0, duration));
    setStatus('Playing simulated Stickies cues. No sensor is connected.');
  } catch (e) {
    stopPreset(false);
    setStatus('Preset playback failed: ' + e.message);
  }
}
$('preset-play').onclick = () => void replayPreset();
$('preset-stop').onclick = () => {
  pause();
  stopPreset();
};
$('preset-select').onchange = () => {
  pause();
  stopPreset(false);
  selectedCue = 0;
  paintPreset();
  setStatus('Preset selected. Use Play preset to replay from the beginning.');
};
$('preset-new').onclick = () => {
  if (customPresets.length >= 50) {
    setStatus('Library limit reached (50 custom presets).');
    return;
  }
  const preset = {
    id: id(),
    name: 'Untitled preset ' + (customPresets.length + 1),
    cues: [cue(0, 'Initial state', { ...p, animate: false })],
  };
  pause();
  stopPreset(false);
  customPresets.push(preset);
  storePresets();
  selectedCue = 0;
  paintLibrary(preset.id);
  $('preset-name').focus();
  $('preset-name').select();
  setStatus('New preset created from current parameters. Add cues at different times.');
};
$('preset-duplicate').onclick = () => {
  if (customPresets.length >= 50) {
    setStatus('Library limit reached (50 custom presets).');
    return;
  }
  const copy = {
    ...structuredClone(selectedPreset()),
    id: id(),
    builtin: false,
    name: selectedPreset().name.slice(0, 70) + ' copy',
  };
  pause();
  stopPreset(false);
  customPresets.push(copy);
  storePresets();
  selectedCue = 0;
  paintLibrary(copy.id);
  setStatus('Editable copy created. Select a cue to adjust it.');
};
$('preset-name').oninput = () => {
  const preset = selectedPreset();
  if (preset.builtin) return;
  const name = $('preset-name').value.trim();
  if (!name || name.length > 80) return;
  preset.name = name;
  const option = Array.from($('preset-select').options).find(item => item.value === preset.id);
  if (option) option.textContent = name;
  storePresets();
  paintSchedule();
};
function saveCue(add) {
  const preset = selectedPreset();
  if (preset.builtin) {
    setStatus('Duplicate this built-in preset before editing.');
    return;
  }
  const seconds = $('cue-time').valueAsNumber,
    label = $('cue-label').value.trim();
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) {
    setStatus('Cue time must fall within the source video.');
    return;
  }
  if (!label || label.length > 80) {
    setStatus('Enter a cue label with 1–80 characters.');
    return;
  }
  if (!add && selectedCue === 0 && seconds !== 0) {
    setStatus('The initial cue must remain at 0 seconds.');
    return;
  }
  try {
    const item = {
        at: seconds / duration,
        label,
        parameters: PresetModel.parameters({ ...p, animate: false }),
      },
      candidate = structuredClone(preset);
    if (add) candidate.cues.push(item);
    else candidate.cues[selectedCue] = item;
    const checked = PresetModel.validate(candidate);
    preset.cues = checked.cues;
    selectedCue = preset.cues.findIndex(c => c.at === item.at);
    stopPreset(false);
    const saved = storePresets();
    paintPreset();
    const verb = add ? 'Cue added.' : 'Cue updated.';
    setStatus(
      saved
        ? verb + ' Parameters captured from the inspector.'
        : 'Cue updated in memory. Export JSON to keep a copy.',
    );
  } catch (e) {
    setStatus(e.message);
  }
}
$('cue-save').onclick = () => saveCue(false);
$('cue-add').onclick = () => saveCue(true);
$('cue-now').onclick = () => ($('cue-time').value = time.toFixed(2));
$('cue-remove').onclick = () => {
  const preset = selectedPreset();
  if (preset.builtin || selectedCue === 0) return;
  stopPreset(false);
  preset.cues.splice(selectedCue, 1);
  selectedCue = 0;
  storePresets();
  paintPreset();
  setStatus('Cue removed.');
};
$('preset-delete').onclick = () => {
  const preset = selectedPreset();
  if (preset.builtin) return;
  pause();
  stopPreset(false);
  customPresets = customPresets.filter(item => item.id !== preset.id);
  storePresets();
  selectedCue = 0;
  paintLibrary();
  setStatus('Custom preset removed.');
};
$('preset-export').onclick = () =>
  download(
    new Blob([JSON.stringify({ kind: 'stickies-preset', version: 1, preset: selectedPreset() }, null, 2)], {
      type: 'application/json',
    }),
    'stickies-preset.json',
  );
$('preset-import').onclick = () => $('preset-file').click();
$('preset-file').onchange = async () => {
  try {
    const file = $('preset-file').files[0];
    if (!file) return;
    if (file.size > 1000000) throw new Error('Preset files must be under 1 MB.');
    if (customPresets.length >= 50) throw new Error('Library limit reached (50 custom presets).');
    const data = JSON.parse(await file.text());
    if (data.kind !== 'stickies-preset' || data.version !== 1) throw new Error('Unsupported preset format.');
    const preset = { ...PresetModel.validate(data.preset), id: id() };
    pause();
    stopPreset(false);
    customPresets.push(preset);
    storePresets();
    selectedCue = 0;
    paintLibrary(preset.id);
    setStatus('Preset imported. Video files are not included in presets.');
  } catch (e) {
    setStatus('Preset import failed: ' + e.message);
  } finally {
    $('preset-file').value = '';
  }
};
// Keep inspector edits separate from simulated updates. Programmatic sync emits no input event.
document.querySelectorAll('[data-key]').forEach(el => el.addEventListener('input', presetManualOverride));
canvas.addEventListener('pointerdown', presetManualOverride);
$('reset').addEventListener('click', presetManualOverride);
$('recipe').addEventListener('change', presetManualOverride);
const scheduleFields = [
  ['speed', 'Playback speed (×)', v => v.toFixed(2)],
  ['zoom', 'Zoom (×)', v => v.toFixed(2)],
  ['x', 'Focus X (%)', v => v.toFixed(1)],
  ['y', 'Focus Y (%)', v => v.toFixed(1)],
  ['animate', 'Zoom animation (0 / 1)', v => (v ? '1' : '0')],
  ['start', 'Animation start (s)', v => v.toFixed(2)],
  ['end', 'Animation end (s)', v => v.toFixed(2)],
];
function paintSchedule() {
  const preset = selectedPreset(),
    table = $('parameter-schedule');
  $('schedule-name').textContent = preset.name;
  table.replaceChildren();
  const head = document.createElement('thead'),
    header = document.createElement('tr');
  const label = document.createElement('th');
  label.scope = 'col';
  label.textContent = 'Parameter / source time';
  header.append(label);
  preset.cues.forEach((cue, index) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.dataset.cue = index;
    const timestamp = document.createElement('strong');
    timestamp.textContent = (cue.at * duration).toFixed(2) + ' s';
    const name = document.createElement('span');
    name.textContent = cue.label;
    th.append(timestamp, name);
    header.append(th);
  });
  head.append(header);
  table.append(head);
  const body = document.createElement('tbody');
  for (const [key, title, format] of scheduleFields) {
    const row = document.createElement('tr'),
      label = document.createElement('th');
    label.scope = 'row';
    label.textContent = title;
    row.append(label);
    preset.cues.forEach((cue, index) => {
      const cell = document.createElement('td');
      cell.dataset.cue = index;
      cell.textContent = format(cue.parameters[key]);
      row.append(cell);
    });
    body.append(row);
  }
  table.append(body);
  paintTimeline(preset);
}
const timelineNS = 'http://www.w3.org/2000/svg';
function timelineNode(tag, attrs, text) {
  const node = document.createElementNS(timelineNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}
// Chart geometry in SVG units (viewBox 0 0 1000 218).
const TL = { left: 120, width: 860, right: 980, top: 24, laneH: 92, height: 218, clipH: 26, curveH: 40 };
const TL_LANES = [
  { key: 'speed', label: 'Speed', min: 0.25, max: 3, color: '#3fb8af' },
  { key: 'zoom', label: 'Zoom', min: 1, max: 5, color: '#d9a441' },
];
function segmentDescription(key, value) {
  if (key === 'zoom') return value > 1 ? 'Zoom' : 'Full';
  if (value < 1) return 'Slow';
  return value > 1 ? 'Fast' : 'Normal';
}
function paintRuler(svg) {
  const { left, width, top, height } = TL;
  svg.append(timelineNode('rect', { x: 0, y: 0, width: left - 8, height, fill: '#1b1b1b' }));
  svg.append(timelineNode('line', { x1: left - 8, x2: left - 8, y1: 0, y2: height, stroke: '#2b2b2b' }));
  svg.append(
    timelineNode('rect', { x: left - 8, y: 0, width: 1000 - left + 8, height: top - 2, fill: '#1b1b1b' }),
  );
  svg.append(timelineNode('line', { x1: 0, x2: 1000, y1: top - 2, y2: top - 2, stroke: '#2b2b2b' }));
  for (let i = 0; i <= 40; i++) {
    const x = left + (width * i) / 40,
      major = i % 5 === 0;
    svg.append(
      timelineNode('line', {
        x1: x,
        x2: x,
        y1: top - (major ? 11 : 6),
        y2: top - 2,
        stroke: major ? '#5a5a5a' : '#363636',
      }),
    );
    if (!major) continue;
    const last = i === 40;
    const attrs = {
      x: x + (last ? -3 : 3),
      y: 13,
      fill: '#7a7a7a',
      'font-size': 9.5,
      'text-anchor': last ? 'end' : 'start',
    };
    svg.append(timelineNode('text', attrs, ((duration * i) / 40).toFixed(2)));
    if (i > 0 && !last)
      svg.append(timelineNode('line', { x1: x, x2: x, y1: top, y2: height, stroke: '#1f1f1f' }));
  }
}
function paintSegment(svg, lane, y, cue, index, end) {
  const { key, color } = lane,
    value = cue.parameters[key],
    x = TL.left + TL.width * cue.at,
    w = TL.width * (end - cue.at),
    neutral = value === 1,
    from = (cue.at * duration).toFixed(2);
  const group = timelineNode('g', {
    'data-segment': index,
    role: 'button',
    tabindex: 0,
    'aria-label': `${cue.label}, ${key} target ${value} times at ${from} seconds`,
  });
  group.append(
    timelineNode('rect', {
      class: 'clip',
      x: x + 0.5,
      y,
      width: Math.max(1, w - 2),
      height: TL.clipH,
      rx: 3,
      fill: color,
      'fill-opacity': neutral ? 0.07 : 0.2,
      stroke: color,
      'stroke-opacity': neutral ? 0.25 : 0.55,
      'stroke-width': 1,
    }),
  );
  group.append(
    timelineNode('rect', {
      x: x + 0.5,
      y,
      width: Math.min(2.5, Math.max(1, w - 2)),
      height: TL.clipH,
      fill: color,
      'fill-opacity': neutral ? 0.4 : 0.95,
    }),
  );
  if (w > 48) {
    const fill = neutral ? '#9a9a9a' : '#f0f0f0';
    group.append(
      timelineNode('text', { x: x + 10, y: y + 17, fill, 'font-size': 11 }, value.toFixed(2) + '×'),
    );
  }
  if (w > 120) {
    const fill = neutral ? '#6e6e6e' : '#bdbdbd';
    group.append(
      timelineNode('text', { x: x + 52, y: y + 17, fill, 'font-size': 10.5 }, segmentDescription(key, value)),
    );
  }
  const to = (end * duration).toFixed(2);
  group.append(timelineNode('title', {}, `${cue.label} | Target ${value.toFixed(2)}× | ${from}–${to} s`));
  const seconds = cue.at * duration;
  group.onclick = event => {
    event.stopPropagation();
    void previewSchedule(seconds);
  };
  group.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void previewSchedule(seconds);
  };
  svg.append(group);
}
function paintLane(svg, preset, lane, laneIndex) {
  const { key, label, min, max, color } = lane,
    { left, right, width, clipH, curveH } = TL;
  const y = TL.top + 8 + laneIndex * TL.laneH,
    curveTop = y + clipH + 8;
  if (laneIndex)
    svg.append(timelineNode('line', { x1: 0, x2: 1000, y1: y - 5, y2: y - 5, stroke: '#262626' }));
  svg.append(timelineNode('rect', { x: 10, y: y + 7, width: 3, height: 12, rx: 1.5, fill: color }));
  svg.append(
    timelineNode('text', { x: 20, y: y + 17, fill: '#e8e8e8', 'font-size': 11.5, 'font-weight': 600 }, label),
  );
  svg.append(timelineNode('text', { x: 10, y: curveTop + 10, fill: '#6e6e6e', 'font-size': 9.5 }, max + '×'));
  svg.append(
    timelineNode('text', { x: 10, y: curveTop + curveH, fill: '#6e6e6e', 'font-size': 9.5 }, min + '×'),
  );
  preset.cues.forEach((cue, index) =>
    paintSegment(svg, lane, y, cue, index, preset.cues[index + 1]?.at ?? 1),
  );
  const yOf = value => curveTop + curveH - ((value - min) / (max - min)) * curveH;
  svg.append(
    timelineNode('line', {
      x1: left,
      x2: right,
      y1: yOf(1),
      y2: yOf(1),
      stroke: '#3a3a3a',
      'stroke-dasharray': '2 4',
    }),
  );
  let d = '';
  for (let i = 0; i <= 600; i++) {
    const value = PresetModel.sample(preset, (duration * i) / 600, duration).parameters[key];
    d += (i ? ' L' : 'M') + (left + (width * i) / 600).toFixed(2) + ' ' + yOf(value).toFixed(2);
  }
  const area = `${d} L${right} ${curveTop + curveH} L${left} ${curveTop + curveH} Z`;
  svg.append(timelineNode('path', { d: area, fill: color, 'fill-opacity': 0.07, stroke: 'none' }));
  svg.append(
    timelineNode('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }),
  );
}
function paintTimeline(preset) {
  const svg = $('schedule-chart');
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 1000 ${TL.height}`);
  $('schedule-seek').max = duration;
  paintRuler(svg);
  TL_LANES.forEach((lane, index) => paintLane(svg, preset, lane, index));
  const head = timelineNode('g', { id: 'schedule-playhead-head' });
  head.append(timelineNode('path', { d: 'M-6 2 H6 V10 L0 16 L-6 10 Z', fill: '#ff5b52' }));
  svg.append(
    timelineNode('line', {
      id: 'schedule-playhead',
      x1: TL.left,
      x2: TL.left,
      y1: TL.top,
      y2: TL.height,
      stroke: '#ff5b52',
      'stroke-width': 1.25,
    }),
  );
  svg.append(head);
  updateTimelineCursor();
}
let lastTimelinePaint = 0,
  lastMapPaint = 0,
  pendingScheduleTime = null,
  scheduleSeeking = false;
function updateTimelineCursor() {
  const now = performance.now();
  if (now - lastTimelinePaint < 50) return;
  lastTimelinePaint = now;
  $('live-speed').textContent = (demo ? p.speed : video.playbackRate).toFixed(2) + '×';
  $('live-zoom').textContent = geometry().z.toFixed(2) + '×';
  $('live-time').textContent = time.toFixed(2) + ' s';
  $('live-play-state').textContent = playing ? 'Playing' : 'Paused';
  $('live-event').textContent = attachedPreset
    ? PresetModel.sample(attachedPreset, time, duration).label
    : '';
  const sample = PresetModel.sample(selectedPreset(), time, duration),
    v = sample.parameters,
    target = selectedPreset().cues[sample.index].parameters;
  $('schedule-mode').textContent = attachedPreset ? 'Following' : 'Not applied';
  $('schedule-mode').classList.toggle('is-following', !!attachedPreset);
  const line = $('schedule-playhead');
  if (line) {
    const x = TL.left + TL.width * Math.max(0, Math.min(1, time / duration));
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    line.setAttribute('stroke-opacity', attachedPreset ? 1 : 0.75);
    $('schedule-playhead-head').setAttribute('transform', `translate(${x} 7)`);
  }
  if (!scheduleSeeking) $('schedule-seek').value = time;
  $('schedule-time').value = time.toFixed(2) + ' / ' + duration.toFixed(2) + ' s';
  $('timeline-readout').textContent =
    'Cue ' +
    (sample.index + 1) +
    '/' +
    selectedPreset().cues.length +
    '  ' +
    sample.label +
    '   ·   target ' +
    target.speed.toFixed(2) +
    '× / ' +
    target.zoom.toFixed(2) +
    '×   ·   now ' +
    v.speed.toFixed(2) +
    '× / ' +
    v.zoom.toFixed(2) +
    '×';
  document
    .querySelectorAll('[data-segment]')
    .forEach(node =>
      node.classList.toggle(
        'active-segment',
        !!attachedPreset && Number(node.dataset.segment) === sample.index,
      ),
    );
  if (now - lastMapPaint > 100) {
    lastMapPaint = now;
    paintFocusMap();
  }
}
function paintFocusMap() {
  const map = $('focus-map'),
    c = map.getContext('2d'),
    w = map.width,
    h = map.height;
  const ratio = demo ? 16 / 9 : video.videoWidth / video.videoHeight || 16 / 9,
    fw = Math.min(w, h * ratio),
    fh = fw / ratio,
    ox = (w - fw) / 2,
    oy = (h - fh) / 2;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#0c0c0c';
  c.fillRect(0, 0, w, h);
  if (video.readyState >= 2) c.drawImage(video, ox, oy, fw, fh);
  const g = geometry(),
    x = (-g.tx / g.z / g.w) * fw,
    y = (-g.ty / g.z / g.h) * fh,
    cw = fw / g.z,
    ch = fh / g.z;
  c.fillStyle = '#0008';
  c.beginPath();
  c.rect(ox, oy, fw, fh);
  c.rect(ox + x, oy + y, cw, ch);
  c.fill('evenodd');
  c.strokeStyle = '#4c8dff';
  c.lineWidth = 2;
  c.strokeRect(ox + x + 1, oy + y + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
  $('focus-caption').textContent =
    g.z.toFixed(2) +
    '× · Center ' +
    (((x + cw / 2) / fw) * 100).toFixed(1) +
    '%, ' +
    (((y + ch / 2) / fh) * 100).toFixed(1) +
    '%';
}
// Scrubbing can request seeks faster than the video completes them. Only the latest
// request matters, so seeks run one at a time and intermediate requests are skipped.
async function drainScheduleSeeks() {
  if (pendingScheduleTime === null) return;
  const next = pendingScheduleTime;
  pendingScheduleTime = null;
  await seekTo(next);
  await drainScheduleSeeks();
}
async function previewSchedule(seconds) {
  if (recording) return;
  pendingScheduleTime = seconds;
  if (scheduleSeeking) return;
  scheduleSeeking = true;
  pause();
  attachedPreset = structuredClone(selectedPreset());
  lastCue = -1;
  $('compare').checked = false;
  try {
    await drainScheduleSeeks();
    sync();
    paintSimulation(PresetModel.sample(attachedPreset, time, duration));
  } catch (error) {
    setStatus(error.message);
  } finally {
    scheduleSeeking = false;
    lastTimelinePaint = 0;
    updateTimelineCursor();
  }
}
$('schedule-seek').oninput = () => void previewSchedule(Number($('schedule-seek').value));
$('schedule-chart').onclick = event => {
  const svg = $('schedule-chart'),
    point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  if (point.x >= TL.left)
    void previewSchedule(Math.max(0, Math.min(1, (point.x - TL.left) / TL.width)) * duration);
};
$('schedule-expand').onclick = () => {
  const expanded = $('schedule-expand').getAttribute('aria-expanded') !== 'true';
  $('schedule-expand').setAttribute('aria-expanded', String(expanded));
  $('schedule-expand').textContent = expanded ? 'Compact timeline' : 'Expand timeline';
  document.querySelector('main').classList.toggle('schedule-expanded', expanded);
};
$('schedule-csv').onclick = () => {
  try {
    download(
      new Blob(['\uFEFF' + ScheduleExport.csv(PresetModel, selectedPreset(), duration)], {
        type: 'text/csv;charset=utf-8',
      }),
      'parameter-timeline.csv',
    );
    setStatus('CSV exported: selected preset, sampled every 0.1 source seconds.');
  } catch (error) {
    setStatus(error.message);
  }
};
$('schedule-json').onclick = () => {
  download(
    new Blob(
      [
        JSON.stringify(
          { kind: 'stickies-preset', version: 1, sourceDurationSeconds: duration, preset: selectedPreset() },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    ),
    'parameter-timeline.json',
  );
  setStatus('Preset JSON exported. Import JSON restores its cues.');
};
paintLibrary();
paintSimulation(null);
