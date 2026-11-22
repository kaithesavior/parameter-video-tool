// Real-time parameter input: validation, ordering, smoothing and staleness.
// Pure logic shared by the browser (live.js) and the server (server.cjs).
(function (root) {
  'use strict';
  // View parameters: playback speed, zoom and focus (percent of the frame).
  const LIMITS = { speed: [0.25, 3], zoom: [1, 5], x: [0, 100], y: [0, 100] };
  const KEYS = Object.keys(LIMITS);
  // `time`: where in the video the sender's subject is (seconds), e.g. a learner tracked by
  // the Stickies algorithms. It is a position to follow, not a smoothed view value.
  const TIME_LIMITS = [0, 36000];
  // Following a position: drifts below DEAD_ZONE are left alone, larger ones are closed by
  // speeding up or slowing down (over about 1 / GAIN seconds), and beyond SEEK the video jumps.
  const FOLLOW = {
    deadZone: 0.08,
    gain: 1,
    maxCorrection: 0.75,
    seek: 1.5,
    minRate: 0.1,
    maxRate: 4,
    step: 0.05,
  };

  // Turns one incoming message into a safe partial patch. Never throws.
  // Accepted: {speed?, zoom?, x?, y?, time?, video?, source?, seq?}; numbers are clamped.
  // `source` says what produced the values (e.g. "hmm · curls-x1.50"); it is shown, not applied.
  // `video` names the video the values belong to (a file name, or a path whose last part is
  // compared); the editor ignores messages for another video. Without it, values apply to any video.
  const MAX_VIDEO_NAME = 200,
    MAX_SOURCE = 80;
  function normalize(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return { ok: false, error: 'Message must be a JSON object.' };
    const patch = {};
    for (const key of KEYS) {
      const value = message[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value))
        return { ok: false, error: `"${key}" must be a finite number.` };
      patch[key] = Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], value));
    }
    let time = null;
    if (message.time !== undefined) {
      if (typeof message.time !== 'number' || !Number.isFinite(message.time))
        return { ok: false, error: '"time" must be a finite number of seconds.' };
      time = Math.min(TIME_LIMITS[1], Math.max(TIME_LIMITS[0], message.time));
    }
    if (!Object.keys(patch).length && time === null)
      return { ok: false, error: 'No supported parameters. Send any of: ' + KEYS.join(', ') + ', time.' };
    let video = null;
    if (message.video !== undefined) {
      if (typeof message.video !== 'string' || !videoName(message.video) || message.video.length > MAX_VIDEO_NAME)
        return { ok: false, error: `"video" must be a video file name of 1–${MAX_VIDEO_NAME} characters.` };
      video = message.video;
    }
    let source = null;
    if (message.source !== undefined) {
      if (typeof message.source !== 'string' || !message.source.trim() || message.source.length > MAX_SOURCE)
        return { ok: false, error: `"source" must be text of 1–${MAX_SOURCE} characters.` };
      source = message.source.trim();
    }
    const seq = Number.isSafeInteger(message.seq) && message.seq >= 0 ? message.seq : null;
    return { ok: true, patch, time, video, source, seq };
  }

  // The file name part of a video reference: "videos/curls.mp4" and "curls.mp4" -> "curls.mp4".
  function videoName(ref) {
    return String(ref).split(/[\\/]/).pop().trim();
  }
  // Whether a message's `video` is meant for the open video. No `video` means any video.
  function isForVideo(messageVideo, openVideoRef) {
    if (messageVideo === null || messageVideo === undefined) return true;
    return !!openVideoRef && videoName(messageVideo) === videoName(openVideoRef);
  }

  // Playback rate that keeps the video on a followed position. `drift` = target - video
  // time, in seconds. Returns {rate, seek}: seek means jump to the target instead.
  function follow(speed, drift) {
    if (!Number.isFinite(drift)) return { rate: speed, seek: false };
    if (Math.abs(drift) >= FOLLOW.seek) return { rate: speed, seek: true };
    if (Math.abs(drift) < FOLLOW.deadZone) return { rate: speed, seek: false };
    const correction = Math.max(-FOLLOW.maxCorrection, Math.min(FOLLOW.maxCorrection, drift * FOLLOW.gain));
    // Quantised, because changing playbackRate on every frame makes the audio glitch.
    const rate = Math.round((speed + correction) / FOLLOW.step) * FOLLOW.step;
    return { rate: Math.max(FOLLOW.minRate, Math.min(FOLLOW.maxRate, rate)), seek: false };
  }

  // One input channel. Times are milliseconds from a monotonic clock.
  function createChannel({ staleMs = 1000, smoothingMs = 80 } = {}) {
    let target = null,
      current = null,
      position = null,
      lastSeq = null,
      lastAt = -Infinity,
      received = 0,
      dropped = 0,
      arrivals = [],
      lastError = '';
    function receive(message, now) {
      const result = normalize(message);
      if (!result.ok) {
        dropped++;
        lastError = result.error;
        return result;
      }
      // Drop late packets, but accept a sequence reset from a restarted sender.
      if (result.seq !== null && lastSeq !== null && result.seq <= lastSeq && now - lastAt < staleMs) {
        dropped++;
        lastError = 'Out-of-order message dropped.';
        return { ok: false, error: lastError };
      }
      if (result.seq !== null) lastSeq = result.seq;
      target = { ...target, ...result.patch };
      if (result.time !== null) position = { time: result.time, at: now };
      lastAt = now;
      received++;
      arrivals.push(now);
      while (arrivals.length && now - arrivals[0] > 1000) arrivals.shift();
      return result;
    }
    // Moves the smoothed value toward the target. `from` seeds the first frame so there is no jump.
    function step(from, dtMs) {
      if (!target) return null;
      if (!current) {
        current = {};
        for (const key of KEYS)
          current[key] = Number.isFinite(from?.[key]) ? from[key] : (target[key] ?? LIMITS[key][0]);
      }
      const blend = smoothingMs <= 0 ? 1 : 1 - Math.exp(-Math.max(0, Math.min(250, dtMs)) / smoothingMs);
      const out = {};
      for (const key of Object.keys(target)) {
        const span = LIMITS[key][1] - LIMITS[key][0];
        let next = current[key] + (target[key] - current[key]) * blend;
        if (Math.abs(target[key] - next) < span * 1e-4) next = target[key];
        current[key] = out[key] = next;
      }
      return out;
    }
    // The followed position now: the last `time` moved on at the sender's speed since it
    // arrived. Null when no position was sent or it is stale.
    function positionAt(now) {
      if (!position || now - position.at > staleMs) return null;
      return position.time + ((target?.speed ?? 1) * Math.max(0, now - position.at)) / 1000;
    }
    function state(now) {
      return lastAt === -Infinity ? 'waiting' : now - lastAt > staleMs ? 'stale' : 'live';
    }
    function stats(now) {
      while (arrivals.length && now - arrivals[0] > 1000) arrivals.shift();
      return {
        received,
        dropped,
        rate: arrivals.length,
        lastError,
        sinceLast: now - lastAt,
        target: target && { ...target },
      };
    }
    function reset() {
      target = current = position = null;
      lastSeq = null;
      lastAt = -Infinity;
      arrivals = [];
      lastError = '';
    }
    return { receive, step, positionAt, state, stats, reset };
  }

  const api = { LIMITS, KEYS, FOLLOW, normalize, follow, videoName, isForVideo, createChannel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LiveInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
