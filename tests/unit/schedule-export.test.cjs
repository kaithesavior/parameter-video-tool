const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../../public/js/model/preset-model.js');
const { csv } = require('../../public/js/model/schedule-export.js');

const preset = {
  name: 'Lesson',
  cues: [
    { at: 0, label: 'Start', parameters: { ...model.base } },
    { at: 0.5, label: '=HYPERLINK("x")', parameters: { ...model.base, zoom: 2, speed: 0.5 } },
  ],
};

function rows(text) {
  return text.split('\r\n').map(line => JSON.parse('[' + line.replace(/""/g, '\\"') + ']'));
}

test('samples every 0.1 s and always ends exactly at the duration', () => {
  for (const duration of [1, 1.1, 4.6, 7.7, 8]) {
    const times = rows(csv(model, preset, duration))
      .slice(1)
      .map(row => Number(row[0]));
    assert.equal(times[0], 0);
    assert.equal(times.at(-1), duration, `duration ${duration}`);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], `strictly increasing at ${i}`);
  }
});

test('writes a header, cue columns and booleans as 0/1', () => {
  const [header, first] = rows(csv(model, preset, 8));
  assert.deepEqual(header.slice(0, 3), ['source_time_s', 'cue_index', 'cue_label']);
  assert.deepEqual(header.slice(3), Object.keys(model.base));
  assert.equal(first[1], '1');
  assert.equal(first[header.indexOf('animate')], '0');
});

test('neutralises spreadsheet formulas in labels', () => {
  const last = rows(csv(model, preset, 8)).at(-1);
  assert.equal(last[2], `'=HYPERLINK("x")`);
});

test('rejects unusable durations', () => {
  for (const duration of [0, -1, NaN, Infinity, 90000]) assert.throws(() => csv(model, preset, duration));
});
