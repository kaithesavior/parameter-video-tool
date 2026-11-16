(function (root) {
  'use strict';
  function csv(model, preset, duration) {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400)
      throw new Error('Export requires a video duration between 0 and 86400 seconds.');
    const validated = model.validate(preset),
      keys = Object.keys(model.base),
      step = 0.1;
    const cell = value => {
      let s = String(value);
      if (typeof value === 'string' && /^[=+@\-\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const rows = [['source_time_s', 'cue_index', 'cue_label', ...keys].map(cell).join(',')];
    const count = Math.ceil(duration / step);
    for (let i = 0; i <= count; i++) {
      const t = Math.min(i * step, duration),
        sample = model.sample(validated, t, duration);
      rows.push(
        [
          Number(t.toFixed(6)),
          sample.index + 1,
          sample.label,
          ...keys.map(key => {
            const v = sample.parameters[key];
            return typeof v === 'number' ? Number(v.toFixed(6)) : typeof v === 'boolean' ? Number(v) : v;
          }),
        ]
          .map(cell)
          .join(','),
      );
    }
    return rows.join('\r\n');
  }
  const api = { csv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScheduleExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
