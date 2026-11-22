// Per-video workspace state: each video keeps its own view parameters, cue timelines,
// selected timeline and export range. Pure logic shared by the browser (presets.js) and tests.
(function (root) {
  'use strict';
  const KEY_PREFIX = 'stickies.video.v1.';
  // Format 2: the selected timeline is always the user's choice. Format 1 states could hold a
  // template the editor selected automatically, which is not restored.
  const FORMAT = 2;
  const CUSTOM_ID = /^custom-[\w-]{1,60}$/;

  function key(videoId) {
    return KEY_PREFIX + videoId;
  }

  function serialize(state) {
    return JSON.stringify({
      version: 1,
      format: FORMAT,
      params: state.params,
      presets: state.presets,
      selectedPresetId: state.selectedPresetId,
      range: state.range,
    });
  }

  // Restores what can be read and reports how many timelines were dropped, so one damaged
  // entry never discards the rest. `newId` makes ids for timelines stored without a valid one.
  function restore(raw, model, newId) {
    const empty = { params: { ...model.base }, presets: [], selectedPresetId: null, range: null, skipped: 0 };
    if (raw === null || raw === undefined || raw === '') return empty;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ...empty, skipped: 1 };
    }
    if (!data || typeof data !== 'object' || data.version !== 1) return { ...empty, skipped: 1 };
    let params = empty.params;
    try {
      params = model.parameters(data.params);
    } catch {
      // Damaged parameters fall back to the defaults.
    }
    const presets = [];
    let skipped = 0;
    for (const item of Array.isArray(data.presets) ? data.presets : []) {
      if (presets.length >= model.MAX_CUSTOM_PRESETS) {
        skipped++;
        continue;
      }
      try {
        const id = typeof item?.id === 'string' && CUSTOM_ID.test(item.id) ? item.id : newId();
        presets.push({ ...model.validate(item), id });
      } catch {
        skipped++;
      }
    }
    const range = data.range;
    const validRange =
      range && Number.isFinite(range.in) && Number.isFinite(range.out) && range.in >= 0 && range.out > range.in;
    return {
      params,
      presets,
      selectedPresetId: restoredSelection(data),
      range: validRange ? { in: range.in, out: range.out } : null,
      skipped,
    };
  }

  function restoredSelection(data) {
    const id = data.selectedPresetId;
    if (typeof id !== 'string') return null;
    if (data.format !== FORMAT && id.startsWith('builtin-')) return null;
    return id;
  }

  // Moves a video's saved state to a new id (used when a video moves into the videos folder).
  function move(storage, fromId, toId) {
    const from = key(fromId),
      to = key(toId);
    const raw = storage.getItem(from);
    if (raw !== null && storage.getItem(to) === null) storage.setItem(to, raw);
    storage.removeItem(from);
  }

  const api = { KEY_PREFIX, FORMAT, key, serialize, restore, move };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VideoState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
