const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../preset-model.js');
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
