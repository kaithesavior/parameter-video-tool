'use strict';
// Live parameter input. Sources:
//   1. Server relay: anything that POSTs JSON to /input (sensor bridge, script, OSC/MIDI gateway).
//   2. In-page:      window.StickiesLive.push({speed, zoom, x, y, elbow, seq}) from Web Serial, WebHID, etc.
// Every message is validated and clamped (LiveInput.normalize), late packets are dropped,
// and values are smoothed per frame so jittery sensors do not shake the picture.
//
// Two kinds of values arrive:
//   view (speed, zoom, x, y)  drive the player; a manual edit or preset takes them over
//   body (elbow)              drive the muscle highlight; they keep flowing while live input is on
const LIVE_VIEW_KEYS = ['speed', 'zoom', 'x', 'y'];
const liveChannel = LiveInput.createChannel({ staleMs: 1000, smoothingMs: 80 });
let liveEnabled = false,
  liveFollowView = true,
  liveSource = null,
  liveConnection = 'closed',
  liveLastPaint = 0,
  liveLastSync = 0;

// ----- Connection ---------------------------------------------------------------------

function liveConnect() {
  if (liveSource) return;
  if (typeof EventSource === 'undefined' || location.protocol === 'file:') {
    liveConnection = 'unavailable';
    return;
  }
  liveConnection = 'connecting';
  liveSource = new EventSource('/live');
  liveSource.onopen = () => {
    liveConnection = 'open';
  };
  // EventSource reconnects by itself; we only reflect the state.
  liveSource.onerror = () => {
    liveConnection = liveSource?.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting';
  };
  liveSource.onmessage = event => {
    try {
      liveAccept(JSON.parse(event.data));
    } catch {
      // Ignore frames that are not JSON; the server only sends validated JSON.
    }
  };
}

function liveDisconnect() {
  liveSource?.close();
  liveSource = null;
  liveConnection = 'closed';
}

// ----- Receiving and applying ------------------------------------------------------------

function liveHasView(patch) {
  return LIVE_VIEW_KEYS.some(key => key in patch);
}

function liveAccept(message) {
  if (!liveEnabled) return { ok: false, error: 'Live input is off.' };
  return liveChannel.receive(message, performance.now());
}

function liveSetEnabled(on, message) {
  liveEnabled = on;
  liveFollowView = true;
  $('live-enable').checked = on;
  liveChannel.reset();
  if (on) {
    liveConnect();
    setStatus(message || 'Following live input. Manual edits take over speed, zoom and focus.');
  } else {
    liveDisconnect();
    if (message) setStatus(message);
  }
  livePaint(true);
}

function liveApplyView(view) {
  if (!liveFollowView || !liveHasView(view)) return;
  if (typeof attachedPreset !== 'undefined' && attachedPreset) stopPreset(false);
  Object.assign(p, view);
  // Setting playbackRate every frame causes audio glitches; only apply real changes.
  if (!demo && Math.abs(video.playbackRate - p.speed) > 0.004) video.playbackRate = p.speed;
  const now = performance.now();
  const editing = document.activeElement?.matches?.('input[type=number],input[type=text]');
  if (now - liveLastSync > 100 && !editing) {
    liveLastSync = now;
    sync();
  }
}

// Called from the render loop after presets, so live view values win while followed.
// It keeps running during export, so a live session can be recorded.
function liveFrame(dtMs) {
  const values = liveEnabled ? liveChannel.step(p, dtMs) : null;
  if (values) {
    const { elbow, ...view } = values;
    if (elbow !== undefined && typeof muscleMotion === 'function') muscleMotion(elbow, dtMs);
    liveApplyView(view);
  }
  livePaint();
}

// A manual edit or preset takes over the view; body movement keeps flowing.
function liveManualOverride() {
  if (!liveEnabled || !liveFollowView) return;
  liveFollowView = false;
  setStatus(
    'Live speed, zoom and focus paused for your edit; body movement still drives the highlight. Switch live input off and on to follow again.',
  );
  livePaint(true);
}

// ----- Panel ---------------------------------------------------------------------------------

function liveStateLabel(now) {
  if (!liveEnabled) return { label: 'Off', tone: '' };
  const state = liveChannel.state(now);
  // In-page sources can be live without the server, so data wins over connection state.
  if (state === 'live') return { label: liveFollowView ? 'Live' : 'Body only', tone: 'is-live' };
  if (liveConnection === 'unavailable') return { label: 'No server', tone: 'is-error' };
  if (liveConnection !== 'open') return { label: 'Reconnecting', tone: 'is-error' };
  if (state === 'stale') return { label: 'Stale', tone: 'is-warn' };
  return { label: 'Waiting', tone: '' };
}

function liveSinceText(stats) {
  if (!liveEnabled || !stats.received) return '—';
  if (stats.sinceLast < 1000) return Math.round(stats.sinceLast) + ' ms ago';
  return (stats.sinceLast / 1000).toFixed(1) + ' s ago';
}

function liveInputMode(label) {
  if (label === 'Live') return 'Live';
  if (typeof attachedPreset !== 'undefined' && attachedPreset) return 'Preset';
  return 'Manual';
}

function liveSetText(id, text) {
  if ($(id).textContent !== text) $(id).textContent = text;
}

function livePaint(force) {
  const now = performance.now();
  if (!force && now - liveLastPaint < 200) return;
  liveLastPaint = now;
  const stats = liveChannel.stats(now);
  const { label, tone } = liveStateLabel(now);
  liveSetText('live-state', label);
  $('live-state').className = 'badge ' + tone;
  liveSetText('live-rate', liveEnabled && stats.rate ? stats.rate + ' Hz' : '—');
  liveSetText('live-last', liveSinceText(stats));
  liveSetText('live-dropped', String(stats.dropped));
  $('live-dropped').title = stats.lastError || '';
  const rate = stats.rate ? ' · ' + stats.rate + ' Hz' : '';
  liveSetText('footer-mode', liveEnabled ? 'Live input · ' + label + rate : 'Local · No device connected');
  liveSetText('live-input-mode', liveInputMode(label));
}

// ----- Wiring ----------------------------------------------------------------------------------

$('live-enable').addEventListener('change', () => liveSetEnabled($('live-enable').checked));
document.querySelectorAll('[data-key]').forEach(el => el.addEventListener('input', liveManualOverride));
document
  .querySelectorAll('[data-quick-key]')
  .forEach(button => button.addEventListener('click', liveManualOverride));
canvas.addEventListener('pointerdown', liveManualOverride);
$('focus-map').addEventListener('pointerdown', liveManualOverride);
$('reset').addEventListener('click', liveManualOverride);
$('preset-play').addEventListener('click', liveManualOverride);
window.addEventListener('pagehide', liveDisconnect);

window.StickiesLive = Object.freeze({
  push: message => liveAccept(message),
  enable: () => liveSetEnabled(true),
  disable: () => liveSetEnabled(false),
  followView: () => {
    liveFollowView = true;
    livePaint(true);
  },
  status: () => ({
    enabled: liveEnabled,
    followView: liveFollowView,
    connection: liveConnection,
    state: liveChannel.state(performance.now()),
    ...liveChannel.stats(performance.now()),
  }),
});
livePaint(true);
