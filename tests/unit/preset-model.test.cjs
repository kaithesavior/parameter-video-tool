const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../../public/js/model/preset-model.js');
const make = (at, label, patch) => ({ at, label, parameters: { ...model.base, ...patch } });
const sequence = model.validate({
  name: 'Instruction',
  cues: [make(0.5, 'Focus', { zoom: 2, speed: 0.5 }), make(0, 'Ready', {})],
});
test('orders cues and scales their times to source duration', () => {
  assert.equal(model.sample(sequence, 3.99, 8).label, 'Ready');
  assert.equal(model.sample(sequence, 4, 8).label, 'Focus');
  assert.equal(model.sample(sequence, 8, 16).label, 'Focus');
});
test('smooths controls then reaches exact cue parameters', () => {
  assert.equal(model.sample(sequence, 4, 8).parameters.zoom, 1);
  const mid = model.sample(sequence, 4.175, 8).parameters;
  assert.ok(Math.abs(mid.zoom - 1.5) < 1e-9);
  assert.ok(Math.abs(mid.speed - 0.75) < 1e-9);
  const end = model.sample(sequence, 4.5, 8).parameters;
  assert.equal(end.zoom, 2);
  assert.equal(end.speed, 0.5);
});
test('scrubbing and replaying give deterministic results', () => {
  const expected = model.sample(sequence, 5, 8);
  model.sample(sequence, 7, 8);
  model.sample(sequence, 0, 8);
  assert.deepEqual(model.sample(sequence, 5, 8), expected);
  assert.equal(model.sample(sequence, 8, 8).parameters.zoom, 2);
});
test('rejects malformed, overlapping or incomplete cue timelines', () => {
  assert.throws(() => model.validate({ name: 'Bad', cues: [] }));
  assert.throws(() => model.validate({ name: 'Bad', cues: [make(0.1, 'Missing initial', {})] }));
  assert.throws(() => model.validate({ name: 'Bad', cues: [make(0, 'A', {}), make(0, 'B', {})] }));
  assert.throws(() => model.validate({ name: 'Bad', cues: [make(0, 'A', { speed: 0 })] }));
  assert.throws(() => model.parameters({ speed: Infinity }));
  assert.throws(() => model.parameters({ animate: 'true' }));
  assert.throws(() => model.parameters({ animate: true, start: 3, end: 2 }));
});
test('legacy files ignore unsupported fields while preserving motion parameters', () => {
  const p = model.parameters({ zoom: 1.5, legacyEffect: true });
  assert.equal(p.zoom, 1.5);
  assert.equal(p.speed, 1);
  assert.equal('legacyEffect' in p, false);
});
const file = (cues, extra = {}) => ({ kind: 'stickies-preset', version: 1, ...extra, preset: { name: 'File', cues } });
test('fromFile converts cue times in seconds to positions', () => {
  const preset = model.fromFile(
    file([
      { time: 4, label: 'Half', parameters: { zoom: 2 } },
      { time: 0, label: 'Start', parameters: {} },
    ]),
    8,
  );
  assert.deepEqual(
    preset.cues.map(cue => [cue.at, cue.label]),
    [
      [0, 'Start'],
      [0.5, 'Half'],
    ],
  );
  assert.equal(model.sample(preset, 4, 8).label, 'Half');
});
test('fromFile still accepts fractional "at" cues, and "time" wins over "at"', () => {
  const preset = model.fromFile(
    file([
      { at: 0, label: 'Start', parameters: {} },
      { at: 0.9, time: 2, label: 'Both', parameters: {} },
    ]),
    8,
  );
  assert.equal(preset.cues[1].at, 0.25);
});
test('fromFile explains what is wrong', () => {
  const start = { time: 0, label: 'Start', parameters: {} };
  const cases = [
    [{ kind: 'other', version: 1 }, /Unsupported preset format/],
    [file([start, { time: 9, label: 'Late', parameters: {} }]), /Cue 2 is at 9 s, but the video is only 8.00 s long/],
    [file([start, { time: '2', label: 'Text', parameters: {} }]), /Cue 2: "time" must be a number/],
    [file([start, { label: 'None', parameters: {} }]), /Cue 2 needs "time"/],
    [file([{ time: 1, label: 'No start', parameters: {} }]), /first cue must start at 0/],
    [file([{ ...start, parameters: { zoom: 9 } }]), /out of range: zoom/],
    [{ kind: 'stickies-preset', version: 1 }, /"preset" object with a "cues" list/],
  ];
  for (const [data, message] of cases) assert.throws(() => model.fromFile(data, 8), message);
  assert.throws(() => model.fromFile(file([start]), NaN), /Load a video/);
});
test('toFile writes seconds and round-trips through fromFile', () => {
  const original = model.fromFile(
    file([
      { time: 0, label: 'Start', parameters: {} },
      { time: 2.5, label: 'Zoom', parameters: { zoom: 3, speed: 0.5 } },
    ]),
    7.7,
  );
  const data = model.toFile(original, 7.7, 'assets/clip.mp4');
  assert.equal(data.video, 'assets/clip.mp4');
  assert.deepEqual(
    data.preset.cues.map(cue => cue.time),
    [0, 2.5],
  );
  assert.equal('at' in data.preset.cues[1], false);
  assert.deepEqual(model.fromFile(JSON.parse(JSON.stringify(data)), 7.7), original);
  assert.equal('video' in model.toFile(original, 7.7, ''), false);
});
test('the example cue timeline file is valid for curls.mp4', () => {
  const example = require('../../examples/biceps-curl.json');
  assert.equal(example.video, 'curls.mp4');
  assert.equal(model.fromFile(example, 20.8).cues.length, 4);
});

test('cues 1 ms or more apart are allowed in long videos; closer ones are rejected', () => {
  const file = gap => ({
    kind: 'stickies-preset',
    version: 1,
    preset: { name: 't', cues: [{ time: 0, label: 'a', parameters: {} }, { time: gap, label: 'b', parameters: {} }] },
  });
  for (const duration of [20, 3600, 7200]) {
    assert.equal(model.fromFile(file(0.25), duration).cues.length, 2, `0.25 s apart in a ${duration} s video`);
    assert.equal(model.fromFile(file(0.001), duration).cues.length, 2, `1 ms apart in a ${duration} s video`);
    assert.throws(() => model.fromFile(file(0.0004), duration), /same position/);
  }
});
