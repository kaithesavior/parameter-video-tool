'use strict';
// Cue timelines and the per-video workspace.
// Every video keeps its own view parameters, cue timelines, selected timeline and export
// range (video-state.js). Built-in timelines are shared, read-only templates.
// In the Cues control mode, playback follows the selected timeline.

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
  lastSamplePaint = 0;

// ----- Per-video state ------------------------------------------------------------------------
// Saved under the open video's library id. Nothing is saved for videos outside the library.

let videoStateReady = false,
  saveTimer = null,
  // The last Manual values: what is saved while cues or live input drive the view.
  savedParams = { ...defaults };

function saveVideoState() {
  if (!videoStateReady || !currentVideoId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeVideoState, 300);
}
function writeVideoState() {
  saveTimer = null;
  if (!videoStateReady || !currentVideoId) return;
  if (controlMode === 'manual') savedParams = { ...p };
  try {
    localStorage.setItem(
      VideoState.key(currentVideoId),
      VideoState.serialize({
        params: savedParams,
        presets: customPresets,
        selectedPresetId: $('preset-select').value,
        range: { in: Number($('in').value), out: Number($('out').value) },
      }),
    );
  } catch {
    setStatus('Browser storage is full or unavailable. Export the cue timeline JSON to keep a copy.', 'warn');
  }
}
// Called before another video opens: pending changes are written under the outgoing video.
function flushVideoState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    writeVideoState();
  }
  videoStateReady = false;
}
function forgetVideoState(id) {
  // A pending save for this video would write it back when the next video opens.
  if (id === currentVideoId) {
    clearTimeout(saveTimer);
    saveTimer = null;
    videoStateReady = false;
  }
  try {
    localStorage.removeItem(VideoState.key(id));
    localStorage.removeItem(VideoState.key(id) + '.backup');
  } catch {
    // Nothing to forget.
  }
}
// Called by app.js once the new video's duration is known.
function applyVideoState() {
  const id = currentVideoId;
  let raw = null;
  if (id) {
    try {
      raw = localStorage.getItem(VideoState.key(id));
    } catch {
      // Storage blocked: start from defaults.
    }
  }
  const restored = VideoState.restore(raw, PresetModel, presetId);
  if (restored.skipped) {
    try {
      localStorage.setItem(VideoState.key(id) + '.backup', raw);
    } catch {
      // The message still explains what happened.
    }
    const message = `${restored.skipped} saved cue timeline(s) for this video could not be read and were skipped. A copy of the original data is kept under "${VideoState.key(id)}.backup".`;
    console.warn(message);
    startupNotice = message;
  }
  customPresets = restored.presets;
  savedParams = restored.params;
  p = { ...restored.params };
  if (restored.range) {
    const end = Math.min(restored.range.out, Number(floorTo(duration, 2)));
    if (restored.range.in < end) {
      $('in').value = restored.range.in;
      $('out').value = end;
    }
  }
  // A video starts with no cue timeline: nothing is applied until the user imports, creates
  // or picks one (or uses live input).
  const selected = library().some(item => item.id === restored.selectedPresetId)
    ? restored.selectedPresetId
    : NO_TIMELINE;
  selectedCue = 0;
  paintLibrary(selected);
  reattachCues();
  sync();
  videoStateReady = true;
  paintControl();
}

// ----- Library of timelines ------------------------------------------------------------------

function library() {
  return [...builtInPresets, ...customPresets];
}
const NO_TIMELINE = '';
// The selected cue timeline, or null when the video has none selected.
function selectedPreset() {
  const id = $('preset-select').value;
  return (id && library().find(item => item.id === id)) || null;
}
function presetId() {
  return 'custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}
function libraryFull() {
  if (customPresets.length < PresetModel.MAX_CUSTOM_PRESETS) return false;
  setStatus(`Limit reached: ${PresetModel.MAX_CUSTOM_PRESETS} cue timelines per video.`);
  return true;
}
// Adds a timeline to the open video and selects it.
function addCustomPreset(preset, message) {
  customPresets.push(preset);
  selectedCue = 0;
  paintLibrary(preset.id);
  reattachCues();
  saveVideoState();
  setStatus(message);
}
function paintLibrary(selected) {
  const select = $('preset-select');
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = NO_TIMELINE;
  none.textContent = 'No cue timeline';
  select.append(none);
  const groups = [
    ['This video', customPresets],
    ['Templates', builtInPresets],
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      group.append(option);
    }
    select.append(group);
  }
  select.value = selected || NO_TIMELINE;
  paintPreset();
}

// ----- Cues mode ----------------------------------------------------------------------------------

// Called by setControlMode in app.js.
function cuesModeChanged(mode) {
  const preset = selectedPreset();
  attachedPreset = mode === 'cues' && preset ? structuredClone(preset) : null;
  lastCue = -1;
  lastTimelinePaint = 0;
  if (attachedPreset) {
    $('compare').checked = false;
    presetFrame(time);
  }
}
// After the selected timeline or its cues change, Cues mode follows the new version.
function reattachCues() {
  if (controlMode !== 'cues') return;
  const preset = selectedPreset();
  if (!preset) {
    setControlMode('manual', 'No cue timeline selected, so Control switched to Manual.');
    return;
  }
  attachedPreset = structuredClone(preset);
  lastCue = -1;
  presetFrame(time);
}
function presetFrame(t) {
  if (controlMode !== 'cues' || !attachedPreset) return;
  const result = PresetModel.sample(attachedPreset, t, duration);
  Object.assign(p, result.parameters);
  applyPlaybackRate();
  const now = performance.now();
  if (result.index !== lastCue || now - lastSamplePaint > 100) {
    sync();
    lastSamplePaint = now;
    lastCue = result.index;
  }
}

// ----- Cue editor ----------------------------------------------------------------------------------

function paintPreset() {
  const preset = selectedPreset();
  $('cue-list').replaceChildren();
  $('cues-editor').hidden = !preset;
  $('cues-empty').hidden = !!preset;
  if (!preset) {
    $('preset-kind').textContent = '';
    paintCueEditing();
    paintSchedule();
    return;
  }
  selectedCue = Math.min(selectedCue, preset.cues.length - 1);
  $('preset-name').value = preset.name;
  $('preset-kind').textContent = preset.builtin ? 'Template' : 'Saved with this video';
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
    row.onclick = () => void selectCue(index);
    $('cue-list').append(row);
  });
  fillCue();
  paintCueEditing();
  paintSchedule();
}
// Which editing actions are possible: templates are read-only, and cue values are captured
// from View, so adding or updating needs the Manual control mode.
function paintCueEditing() {
  const preset = selectedPreset(),
    manual = controlMode === 'manual';
  // A timeline belongs to a video, so one is needed to make one.
  $('preset-new').disabled = !videoOpen() || recording;
  // Cues mode needs a timeline to follow.
  const cuesOption = document.querySelector('input[name="control-mode"][value="cues"]');
  cuesOption.disabled = !preset || recording;
  cuesOption.closest('label').title = preset
    ? 'Speed, zoom and focus follow the selected cue timeline'
    : 'Select or create a cue timeline first';
  $('preset-duplicate').disabled = !preset || recording;
  if (!preset) {
    $('preset-delete').disabled = true;
    return;
  }
  const builtin = !!preset.builtin;
  $('preset-name').readOnly = builtin;
  $('cue-add').disabled = builtin || !manual || recording;
  $('cue-save').disabled = builtin || !manual || recording;
  $('cue-remove').disabled = builtin || selectedCue === 0 || recording;
  $('preset-delete').disabled = builtin || recording;
  let hint = 'Add cue and Update save the current View values at the chosen time.';
  if (builtin) hint = 'Templates are read-only. Duplicate one to edit it for this video.';
  else if (!manual) hint = 'Switch Control to Manual to capture View values into cues.';
  $('cue-hint').textContent = hint;
}
function fillCue() {
  const item = selectedPreset()?.cues[selectedCue];
  if (!item) return;
  $('cue-time').value = (item.at * duration).toFixed(2);
  $('cue-time').max = duration.toFixed(6);
  $('cue-label').value = item.label;
}
// Selecting a cue moves the playhead to it. In Manual mode its values are loaded into View
// so they can be adjusted and saved back with Update.
async function selectCue(index) {
  if (recording) return;
  const item = selectedPreset()?.cues[index];
  if (!item) return;
  pause();
  selectedCue = index;
  if (controlMode === 'manual') {
    Object.assign(p, item.parameters);
    sync();
  }
  paintPreset();
  await seekTo(item.at * duration).catch(error => setStatus(error.message));
  setStatus(
    controlMode === 'manual'
      ? `Cue ${index + 1} loaded into View. Adjust it, then use Update.`
      : `Cue ${index + 1} selected.`,
  );
}
$('preset-select').onchange = () => {
  selectedCue = 0;
  paintPreset();
  reattachCues();
  saveVideoState();
  const preset = selectedPreset();
  setStatus(preset ? `Cue timeline "${preset.name}" selected.` : 'No cue timeline: View settings apply.');
};
$('preset-new').onclick = () => {
  if (libraryFull()) return;
  addCustomPreset(
    {
      id: presetId(),
      name: 'Untitled timeline ' + (customPresets.length + 1),
      cues: [cue(0, 'Start', { ...p, animate: false })],
    },
    'New cue timeline for this video, starting from the current View. Add cues at other times.',
  );
  $('preset-name').focus();
  $('preset-name').select();
};
$('preset-duplicate').onclick = () => {
  const source = selectedPreset();
  if (!source || libraryFull()) return;
  addCustomPreset(
    {
      ...structuredClone(source),
      id: presetId(),
      builtin: false,
      name: source.name.slice(0, 70) + ' copy',
    },
    'Editable copy saved with this video.',
  );
};
$('preset-name').oninput = () => {
  const preset = selectedPreset();
  if (!preset || preset.builtin) return;
  const name = $('preset-name').value.trim();
  if (!name || name.length > 80) return;
  preset.name = name;
  const option = Array.from($('preset-select').options).find(item => item.value === preset.id);
  if (option) option.textContent = name;
  saveVideoState();
  paintSchedule();
};
function saveCue(add) {
  const preset = selectedPreset();
  if (!preset) {
    setStatus('Create a cue timeline first: click New.');
    return;
  }
  if (preset.builtin) {
    setStatus('Duplicate this template before editing.');
    return;
  }
  const seconds = $('cue-time').valueAsNumber,
    label = $('cue-label').value.trim();
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) {
    setStatus('Cue time must fall within the video.');
    return;
  }
  if (!label || label.length > 80) {
    setStatus('Enter a cue label with 1–80 characters.');
    return;
  }
  if (!add && selectedCue === 0 && seconds !== 0) {
    setStatus('The first cue must stay at 0 seconds.');
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
    const checked = PresetModel.validate(candidate, duration);
    preset.cues = checked.cues;
    selectedCue = preset.cues.findIndex(c => c.at === item.at);
    paintPreset();
    reattachCues();
    saveVideoState();
    setStatus((add ? 'Cue added' : 'Cue updated') + ' with the current View values.');
  } catch (error) {
    setStatus(error.message);
  }
}
$('cue-save').onclick = () => saveCue(false);
$('cue-add').onclick = () => saveCue(true);
$('cue-now').onclick = () => ($('cue-time').value = floorTo(Math.min(time, duration), 2));
$('cue-remove').onclick = () => {
  const preset = selectedPreset();
  if (!preset || preset.builtin || selectedCue === 0) return;
  preset.cues.splice(selectedCue, 1);
  selectedCue = 0;
  paintPreset();
  reattachCues();
  saveVideoState();
  setStatus('Cue removed.');
};
$('preset-delete').onclick = () => {
  const preset = selectedPreset();
  if (!preset || preset.builtin) return;
  if (!confirm(`Delete the cue timeline "${preset.name}" from this video?`)) return;
  customPresets = customPresets.filter(item => item.id !== preset.id);
  selectedCue = 0;
  paintLibrary();
  reattachCues();
  saveVideoState();
  setStatus('Cue timeline deleted.');
};

// ----- Exports ---------------------------------------------------------------------------------------

// Timeline files store cue times in seconds and name the video they were made for.
function exportPresetJson(fileName) {
  const preset = selectedPreset();
  if (!preset) return setStatus('This video has no cue timeline to export.');
  const data = PresetModel.toFile(preset, duration, currentVideoRef());
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), fileName);
  setStatus('Cue timeline exported as JSON with times in seconds. Import restores it.');
}
$('export-json').onclick = () => exportPresetJson('cue-timeline.json');
$('export-csv').onclick = () => {
  if (!selectedPreset()) return setStatus('This video has no cue timeline to export.');
  try {
    download(
      new Blob(['﻿' + ScheduleExport.csv(PresetModel, selectedPreset(), duration)], {
        type: 'text/csv;charset=utf-8',
      }),
      'cue-timeline.csv',
    );
    setStatus('CSV exported: the selected cue timeline, sampled every 0.1 s.');
  } catch (error) {
    setStatus(error.message);
  }
};

// ----- Importing JSON files ------------------------------------------------------------------------
// One JSON file, optionally selected together with its video. Timeline files may name their
// video in "video": a path on this server (videos/…) or a URL is loaded directly; a plain file name
// must match the open video, a video in the library, or the video selected alongside the
// JSON (browsers cannot open local paths by themselves).
const VIDEO_FILE = /\.(mp4|m4v|webm|mov|ogv)$/i;
function isVideoFile(file) {
  return file.type.startsWith('video/') || VIDEO_FILE.test(file.name);
}
function isJsonFile(file) {
  return /\.json$/i.test(file.name) || file.type === 'application/json';
}
function fileBaseName(ref) {
  return ref.split(/[\\/]/).pop();
}
function videoMatches(ref) {
  if (!videoOpen() || !video.currentSrc) return false;
  // Exported files name a served video by its decoded path (videos/a#1.mp4), as currentVideoRef does.
  if (currentVideoRef() === ref) return true;
  if (/^https?:\/\//i.test(ref)) return video.currentSrc === ref;
  if (isServedPath(ref)) return video.currentSrc === new URL(ref, location.href).href;
  return fileBaseName(currentVideoRef()) === fileBaseName(ref);
}
// A relative path such as videos/clip.mp4; absolute local paths cannot be opened by a page.
function isServedPath(ref) {
  return ref.includes('/') && !/^([a-z]:)?[\\/]|^file:/i.test(ref);
}
// A video selected alongside the JSON is added to the video library and opened.
async function openSelectedVideo(file) {
  const [entry] = await importVideos([file]);
  if (!entry) throw new Error(`"${file.name}" is not a playable video. Use MP4 or WebM.`);
  return openLibraryVideo(entry.id);
}
async function prepareVideoFor(ref, selectedVideo) {
  if (selectedVideo) return openSelectedVideo(selectedVideo);
  if (ref === undefined || ref === '') return;
  if (typeof ref !== 'string') throw new Error('"video" must be a file name, a path such as videos/clip.mp4, or a URL.');
  if (videoMatches(ref)) return;
  // videos/<name>: open the library entry, whose URL is properly encoded (names may hold % or #).
  const inFolder = /^videos\/([^/]+)$/.exec(ref);
  const folderVideo = inFolder && libraryFindByName(inFolder[1]);
  if (folderVideo) return openLibraryVideo(folderVideo.id);
  if (/^https?:\/\//i.test(ref) || isServedPath(ref)) return loadVideoUrl(ref, fileBaseName(ref));
  const saved = libraryFindByName(fileBaseName(ref));
  if (saved) return openLibraryVideo(saved.id);
  throw new Error(
    `This timeline is for the video "${fileBaseName(ref)}". Choose Import again and select the JSON file and that video together.`,
  );
}
async function openJsonFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const jsonFiles = files.filter(isJsonFile);
  const videos = files.filter(isVideoFile);
  if (jsonFiles.length !== 1 || videos.length > 1 || jsonFiles.length + videos.length !== files.length)
    throw new Error('Select one JSON file, and optionally one video file.');
  if (jsonFiles[0].size > 1000000) throw new Error('JSON files must be under 1 MB.');
  let data;
  try {
    data = JSON.parse(await jsonFiles[0].text());
  } catch (error) {
    throw new Error(`${jsonFiles[0].name} is not valid JSON (${error.message}).`);
  }
  if (data?.kind !== PresetModel.FILE_KIND) {
    if (videos.length) await openSelectedVideo(videos[0]);
    importParameters(data);
    return;
  }
  await prepareVideoFor(data.video, videos[0]);
  if (!videoOpen())
    throw new Error('Open or import a video first, or select the JSON file and its video together.');
  if (libraryFull()) return;
  const preset = { ...PresetModel.fromFile(data, duration), id: presetId() };
  addCustomPreset(
    preset,
    `Cue timeline "${preset.name}" (${preset.cues.length} cues) added to ${sourceName}. Choose Cues to follow it.`,
  );
}

// ----- Timeline panel ----------------------------------------------------------------------------------

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
  $('schedule-name').textContent = preset ? preset.name : 'No cue timeline';
  document.querySelector('.exact-values').hidden = !preset;
  table.replaceChildren();
  if (!preset) {
    paintTimeline(null);
    return;
  }
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
  // Clicking a cue block selects that cue, like clicking it in the cue list.
  group.onclick = event => {
    event.stopPropagation();
    void selectCue(index);
  };
  group.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void selectCue(index);
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
  if (preset) TL_LANES.forEach((lane, index) => paintLane(svg, preset, lane, index));
  else
    svg.append(
      timelineNode(
        'text',
        { x: TL.left + TL.width / 2, y: TL.top + 92, fill: '#8a8a8a', 'font-size': 12, 'text-anchor': 'middle' },
        'No cue timeline for this video. Import one, or use New in Cue timelines.',
      ),
    );
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
  lastTimelinePaint = 0;
  updateTimelineCursor();
}
let lastTimelinePaint = 0,
  lastMapPaint = 0,
  pendingScheduleTime = null,
  scheduleSeeking = false;
// Marks the cue the playhead is in, in the cue list, the timeline and the value table.
function markCurrentCue(index, following) {
  const active = following ? index : -1;
  document
    .querySelectorAll('.cue-row')
    .forEach(row => row.classList.toggle('is-active', Number(row.dataset.index) === active));
  document
    .querySelectorAll('[data-segment]')
    .forEach(node => node.classList.toggle('active-segment', Number(node.dataset.segment) === active));
  document
    .querySelectorAll('#parameter-schedule [data-cue]')
    .forEach(cell => cell.classList.toggle('current-cue', Number(cell.dataset.cue) === active));
}
function updateTimelineCursor() {
  const now = performance.now();
  if (now - lastTimelinePaint < 50) return;
  lastTimelinePaint = now;
  const following = controlMode === 'cues';
  $('live-speed').textContent = video.playbackRate.toFixed(2) + '×';
  $('live-zoom').textContent = geometry().z.toFixed(2) + '×';
  $('live-time').textContent = time.toFixed(2) + ' s';
  $('live-play-state').textContent = playing ? 'Playing' : 'Paused';
  const preset = selectedPreset();
  const mode = { manual: 'Manual', cues: 'Cues', live: 'Live' }[controlMode];
  if ($('live-input-mode').textContent !== mode) $('live-input-mode').textContent = mode;
  const sample = preset ? PresetModel.sample(preset, time, duration) : null;
  $('live-event').textContent = following && sample ? sample.label : '';
  $('schedule-mode').textContent = following ? 'Active' : 'Inactive';
  $('schedule-mode').classList.toggle('is-following', following);
  const line = $('schedule-playhead');
  if (line) {
    const x = TL.left + TL.width * Math.max(0, Math.min(1, time / duration));
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    line.setAttribute('stroke-opacity', following ? 1 : 0.75);
    $('schedule-playhead-head').setAttribute('transform', `translate(${x} 7)`);
  }
  if (!scheduleSeeking) $('schedule-seek').value = time;
  $('schedule-time').value = time.toFixed(2) + ' / ' + duration.toFixed(2) + ' s';
  if (sample) {
    const v = sample.parameters,
      target = preset.cues[sample.index].parameters;
    $('timeline-readout').textContent =
      `Cue ${sample.index + 1}/${preset.cues.length}  ${sample.label}` +
      `   ·   target ${target.speed.toFixed(2)}× / ${target.zoom.toFixed(2)}×` +
      `   ·   now ${v.speed.toFixed(2)}× / ${v.zoom.toFixed(2)}×`;
  } else {
    $('timeline-readout').textContent = `Now ${p.speed.toFixed(2)}× / ${geometry().z.toFixed(2)}×`;
  }
  markCurrentCue(sample ? sample.index : -1, following);
  if (now - lastMapPaint > 100) {
    lastMapPaint = now;
    paintFocusMap();
  }
  if (controlMode === 'live' || controlMode === 'cues') paintControl();
}
function paintFocusMap() {
  const map = $('focus-map'),
    c = map.getContext('2d'),
    w = map.width,
    h = map.height;
  const { width: fw, height: fh, left: ox, top: oy } = fitFrame(w, h);
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
// The timeline is the scrub bar: it moves the playhead and does not change the control mode.
// Scrubbing can request seeks faster than the video completes them, so seeks run one at a
// time and only the latest request is kept.
async function drainScheduleSeeks() {
  if (pendingScheduleTime === null) return;
  const next = pendingScheduleTime;
  pendingScheduleTime = null;
  await seekTo(next);
  await drainScheduleSeeks();
}
async function scrubTo(seconds) {
  if (recording) return;
  pendingScheduleTime = seconds;
  if (scheduleSeeking) return;
  scheduleSeeking = true;
  pause();
  try {
    await drainScheduleSeeks();
  } catch (error) {
    setStatus(error.message);
  } finally {
    scheduleSeeking = false;
    lastTimelinePaint = 0;
    updateTimelineCursor();
  }
}
$('schedule-seek').oninput = () => void scrubTo(Number($('schedule-seek').value));
$('schedule-chart').onclick = event => {
  const svg = $('schedule-chart'),
    point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  if (point.x >= TL.left) void scrubTo(Math.max(0, Math.min(1, (point.x - TL.left) / TL.width)) * duration);
};
$('schedule-expand').onclick = () => {
  const expanded = $('schedule-expand').getAttribute('aria-expanded') !== 'true';
  $('schedule-expand').setAttribute('aria-expanded', String(expanded));
  $('schedule-expand').textContent = expanded ? 'Compact timeline' : 'Expand timeline';
  document.querySelector('main').classList.toggle('schedule-expanded', expanded);
};
// Write pending changes when the page closes (saving stays on in case the page is restored).
window.addEventListener('pagehide', () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  writeVideoState();
});
paintLibrary();
