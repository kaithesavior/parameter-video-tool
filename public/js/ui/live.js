'use strict';
// Live parameter input: the Live control mode. Sources:
//   1. Server relay: anything that POSTs JSON to /input (sensor bridge, script, OSC/MIDI gateway).
//   2. In-page:      window.StickiesLive.push({speed, zoom, x, y, time, seq}) from Web Serial, WebHID, etc.
// `time` (optional) is a position in the video to follow; see "Following a position" below.
// `video` (optional) names the video the values are for; messages for another video are ignored.
// Every message is validated and clamped (LiveInput.normalize), late packets are dropped,
// and values are smoothed per frame so jittery sensors do not shake the picture.
// Live input is connected only while the Live mode is selected; editing View switches to Manual.
const liveChannel = LiveInput.createChannel({ staleMs: 1000, smoothingMs: 80 });
let liveEnabled = false,
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

// The last message meant for another video ({video, at}), or null. Such messages are not applied.
let liveElsewhere = null,
  // What the sender says produces the values for this video (e.g. "hmm · curls-x1.50"), or ''.
  liveSourceName = '';

function liveAccept(message) {
  if (!liveEnabled) return { ok: false, error: 'Live input is off. Choose the Live control mode.' };
  const now = performance.now(),
    parsed = LiveInput.normalize(message);
  if (parsed.ok && !LiveInput.isForVideo(parsed.video, currentVideoRef())) {
    const name = LiveInput.videoName(parsed.video);
    if (liveElsewhere?.video !== name)
      setStatus(`Live input is for "${name}", not this video. Open "${name}" to follow it.`, 'warn');
    liveElsewhere = { video: name, at: now };
    return { ok: false, error: `For another video: ${name}` };
  }
  const result = liveChannel.receive(message, now);
  if (parsed.ok) liveElsewhere = null;
  if (result.ok && parsed.source) liveSourceName = parsed.source;
  return result;
}

// Why the video cannot play in Live mode right now, or '' when it can (used by play() in app.js).
// Without live input for this video, Live mode has nothing to follow.
function liveBlocker() {
  if (!liveEnabled) return '';
  const now = performance.now();
  if (liveElsewhere && now - liveElsewhere.at < 1000)
    return `Cannot play in Live mode: the live input is for "${liveElsewhere.video}". Open that video, or choose Manual.`;
  if (liveChannel.state(now) === 'live') return '';
  if (liveConnection === 'unavailable')
    return 'Cannot play in Live mode: the live input server is not reachable. Start the tool with npm start.';
  return 'Cannot play in Live mode: no live input is arriving. Start the stream (npm run stickies -- live <session>), or choose Manual.';
}

// Called by prepareSource in app.js when another video opens: the last live values belonged
// to the previous video, so they are dropped until new input arrives for this one.
function liveVideoChanged() {
  liveChannel.reset();
  liveFollowState = { rate: null, drift: null, seekAt: -Infinity };
  liveElsewhere = null;
  liveSourceName = '';
}

// Called by setControlMode in app.js.
function liveModeChanged(mode) {
  const on = mode === 'live';
  if (on === liveEnabled) return;
  liveEnabled = on;
  liveChannel.reset();
  liveSourceName = '';
  liveFollowState = { rate: null, drift: null, seekAt: -Infinity };
  applyPlaybackRate();
  if (on) liveConnect();
  else liveDisconnect();
  livePaint(true);
}

function liveApplyView(view) {
  Object.assign(p, view);
  applyPlaybackRate();
  const now = performance.now();
  const editing = document.activeElement?.matches?.('input[type=number],input[type=text]');
  if (now - liveLastSync > 100 && !editing) {
    liveLastSync = now;
    sync();
  }
}

// ----- Following a position ------------------------------------------------------------------
// Messages with `time` say where in the video the sender's subject is (a learner tracked by
// the Stickies algorithms). While playing, the video speeds up or slows down to stay there, and
// jumps when it is far off. Without `time`, only speed, zoom and focus are applied.
let liveFollowState = { rate: null, drift: null, seekAt: -Infinity };

function liveFollow(now) {
  const target = liveEnabled ? liveChannel.positionAt(now) : null;
  if (target === null || !playing || video.seeking) {
    liveFollowState.rate = null;
    liveFollowState.drift = target === null ? null : liveFollowState.drift;
    return;
  }
  const position = Math.min(duration, target),
    drift = position - video.currentTime;
  liveFollowState.drift = drift;
  const { rate, seek } = LiveInput.follow(p.speed, drift);
  // No jumps while exporting: the recording keeps the export range. One jump at a time.
  if (seek && !recording && now - liveFollowState.seekAt > 500) {
    liveFollowState.seekAt = now;
    liveFollowState.rate = null;
    video.currentTime = position;
  } else liveFollowState.rate = seek ? null : rate;
}

// Used by applyPlaybackRate in app.js.
function liveFollowRate(speed) {
  return liveEnabled && liveFollowState.rate !== null ? liveFollowState.rate : speed;
}

// Called from the render loop. It keeps running during export, so a live session can be recorded.
function liveFrame(dtMs) {
  const values = liveEnabled ? liveChannel.step(p, dtMs) : null;
  if (values) liveApplyView(values);
  if (liveEnabled) {
    liveFollow(performance.now());
    applyPlaybackRate();
  }
  livePaint();
}

// ----- Panel ---------------------------------------------------------------------------------

function liveStateLabel(now) {
  if (!liveEnabled) return { label: 'Off', tone: '' };
  if (liveElsewhere && now - liveElsewhere.at < 1000) return { label: 'Other video', tone: 'is-warn' };
  const state = liveChannel.state(now);
  // In-page sources can be live without the server, so data wins over connection state.
  if (state === 'live') return { label: 'Live', tone: 'is-live' };
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

function liveSetText(id, text) {
  if ($(id).textContent !== text) $(id).textContent = text;
}

function livePaint(force) {
  const now = performance.now();
  if (!force && now - liveLastPaint < 200) return;
  liveLastPaint = now;
  const stats = liveChannel.stats(now);
  const { label } = liveStateLabel(now);
  liveSetText('live-rate', liveEnabled && stats.rate ? stats.rate + ' Hz' : '—');
  liveSetText('live-last', liveSinceText(stats));
  liveSetText('live-dropped', String(stats.dropped));
  $('live-dropped').title = stats.lastError || '';
  // Shown as video minus followed position: negative = the video is behind.
  const drift = liveEnabled ? liveFollowState.drift : null;
  let follow = '—';
  if (drift !== null) follow = (drift > 0 ? '−' : '+') + Math.abs(drift).toFixed(2) + ' s';
  liveSetText('live-follow', follow);
  // The source stays visible after the stream stops, marked as such.
  let source = '—';
  if (liveEnabled && liveSourceName)
    source = liveSourceName + (liveChannel.state(now) === 'live' ? '' : ' (stopped)');
  liveSetText('live-source', source);
  const rate = stats.rate ? ' · ' + stats.rate + ' Hz' : '';
  const elsewhere = label === 'Other video' ? ' · for ' + liveElsewhere.video : '';
  liveSetText(
    'footer-mode',
    liveEnabled ? 'Live input · ' + label + elsewhere + rate : 'Local · No device connected',
  );
}

// ----- Wiring ----------------------------------------------------------------------------------

window.addEventListener('pagehide', liveDisconnect);

window.StickiesLive = Object.freeze({
  push: message => liveAccept(message),
  enable: () => setControlMode('live'),
  disable: () => setControlMode('manual'),
  status: () => ({
    enabled: liveEnabled,
    connection: liveConnection,
    state: liveChannel.state(performance.now()),
    ...liveChannel.stats(performance.now()),
  }),
});
livePaint(true);
