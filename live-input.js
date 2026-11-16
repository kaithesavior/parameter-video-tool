// Real-time parameter input: validation, ordering, smoothing and staleness.
// Pure logic shared by the browser (live.js) and the server (server.cjs).
(function (root) {
  'use strict';
  // View parameters (speed, zoom, x, y) plus body movement: elbow flexion in degrees,
  // 0 = arm straight, 150 = fully curled.
  const LIMITS = { speed: [0.25, 3], zoom: [1, 5], x: [0, 100], y: [0, 100], elbow: [0, 150] };
  const KEYS = Object.keys(LIMITS);

  // Turns one incoming message into a safe partial patch. Never throws.
  // Accepted: {speed?, zoom?, x?, y?, elbow?, seq?} with finite numbers; values are clamped.
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
    if (!Object.keys(patch).length)
      return { ok: false, error: 'No supported parameters. Send any of: ' + KEYS.join(', ') + '.' };
    const seq = Number.isSafeInteger(message.seq) && message.seq >= 0 ? message.seq : null;
    return { ok: true, patch, seq };
  }

  // One input channel. Times are milliseconds from a monotonic clock.
  function createChannel({ staleMs = 1000, smoothingMs = 80 } = {}) {
    let target = null,
      current = null,
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
      target = current = null;
      lastSeq = null;
      lastAt = -Infinity;
      arrivals = [];
      lastError = '';
    }
    return { receive, step, state, stats, reset };
  }

  const api = { LIMITS, KEYS, normalize, createChannel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LiveInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
