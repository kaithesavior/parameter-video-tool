(function (root) {
  'use strict';
  const limits = {
    zoom: [1, 5],
    x: [0, 100],
    y: [0, 100],
    speed: [0.25, 3],
    start: [0, 36000],
    end: [0.1, 36000],
  };
  const base = { zoom: 1, x: 50, y: 50, speed: 1, animate: false, start: 0, end: 3 };
  function parameters(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid cue parameters.');
    const out = { ...base };
    for (const key of Object.keys(base)) {
      const value = input[key];
      if (value === undefined) continue;
      if (typeof value !== typeof base[key]) throw new Error('Invalid parameter: ' + key);
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) || value < limits[key][0] || value > limits[key][1])
      )
        throw new Error('Parameter out of range: ' + key);
      out[key] = value;
    }
    if (out.animate && out.end <= out.start) throw new Error('Zoom animation end must be after its start.');
    return out;
  }
  function validate(input) {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
      throw new Error('Preset name must contain 1–80 characters.');
    if (!Array.isArray(input.cues) || input.cues.length < 1 || input.cues.length > 100)
      throw new Error('A preset needs 1–100 cues.');
    const cues = input.cues
      .map(c => {
        if (!c || !Number.isFinite(c.at) || c.at < 0 || c.at > 1)
          throw new Error('Cue position must be within the video.');
        if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 80)
          throw new Error('Cue labels must contain 1–80 characters.');
        return { at: c.at, label: c.label.trim(), parameters: parameters(c.parameters) };
      })
      .sort((a, b) => a.at - b.at);
    if (cues[0].at !== 0) throw new Error('The first cue must start at 0.');
    for (let i = 1; i < cues.length; i++)
      if (cues[i].at - cues[i - 1].at < 0.0001) throw new Error('Two cues cannot share the same position.');
    return { name: input.name.trim(), cues };
  }
  function sample(preset, t, duration) {
    const position = Math.max(0, Math.min(1, t / Math.max(0.001, duration)));
    let index = 0;
    for (let i = 1; i < preset.cues.length; i++) {
      if (preset.cues[i].at <= position) index = i;
      else break;
    }
    const cue = preset.cues[index],
      target = cue.parameters,
      previous = index ? preset.cues[index - 1].parameters : target;
    // A short media-time transition is deterministic when seeking or replaying.
    const nextAt = preset.cues[index + 1]?.at ?? 1;
    const transition = Math.min(0.35, Math.max(0.001, (nextAt - cue.at) * duration * 0.5));
    let blend = Math.max(0, Math.min(1, (t - cue.at * duration) / transition));
    blend = blend * blend * (3 - 2 * blend);
    const out = { ...target };
    for (const key of ['zoom', 'x', 'y', 'speed'])
      out[key] = previous[key] + (target[key] - previous[key]) * blend;
    // Preset cues supply zoom directly. A nested zoom animation would conflict.
    out.animate = false;
    return { parameters: out, index, label: cue.label, position };
  }
  const api = { base, parameters, validate, sample };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PresetModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
