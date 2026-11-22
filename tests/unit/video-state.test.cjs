const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('../../public/js/model/preset-model.js');
const state = require('../../public/js/model/video-state.js');

let counter = 0;
const newId = () => 'custom-new-' + ++counter;
const timeline = (id, name = 'Lesson') => ({
  id,
  name,
  cues: [{ at: 0, label: 'Start', parameters: { ...model.base } }],
});

test('state round-trips with ids, selection and range', () => {
  const saved = {
    params: { ...model.base, zoom: 2.5, speed: 0.5 },
    presets: [timeline('custom-a'), timeline('custom-b', 'Other')],
    selectedPresetId: 'custom-b',
    range: { in: 1, out: 6.5 },
  };
  const restored = state.restore(state.serialize(saved), model, newId);
  assert.deepEqual(restored.params, saved.params);
  assert.deepEqual(
    restored.presets.map(p => [p.id, p.name]),
    [
      ['custom-a', 'Lesson'],
      ['custom-b', 'Other'],
    ],
  );
  assert.equal(restored.selectedPresetId, 'custom-b');
  assert.deepEqual(restored.range, { in: 1, out: 6.5 });
  assert.equal(restored.skipped, 0);
});

test('nothing stored gives defaults', () => {
  for (const raw of [null, undefined, '']) {
    const restored = state.restore(raw, model, newId);
    assert.deepEqual(restored.params, model.base);
    assert.deepEqual(restored.presets, []);
    assert.equal(restored.skipped, 0);
  }
});

test('damaged parts are dropped without losing the rest', () => {
  const raw = JSON.stringify({
    version: 1,
    params: { zoom: 99 },
    presets: [timeline('custom-ok'), { name: '', cues: [] }, timeline('not a valid id!')],
    selectedPresetId: 42,
    range: { in: 5, out: 2 },
  });
  const restored = state.restore(raw, model, newId);
  assert.deepEqual(restored.params, model.base, 'invalid params fall back to defaults');
  assert.equal(restored.presets.length, 2);
  assert.equal(restored.presets[0].id, 'custom-ok');
  assert.match(restored.presets[1].id, /^custom-new-/, 'invalid ids are replaced');
  assert.equal(restored.skipped, 1);
  assert.equal(restored.selectedPresetId, null);
  assert.equal(restored.range, null);
});

test('unreadable data is reported', () => {
  assert.equal(state.restore('{oops', model, newId).skipped, 1);
  assert.equal(state.restore('{"version":2}', model, newId).skipped, 1);
});

test('keys are per video', () => {
  assert.equal(state.key('file:clip.mov'), 'stickies.video.v1.file:clip.mov');
  assert.notEqual(state.key('video-a'), state.key('video-b'));
});

test('a template chosen automatically by an older version is not restored', () => {
  const old = JSON.stringify({ version: 1, params: model.base, presets: [], selectedPresetId: 'builtin-bold' });
  assert.equal(state.restore(old, model, newId).selectedPresetId, null);
  const oldCustom = JSON.stringify({ version: 1, params: model.base, presets: [timeline('custom-x')], selectedPresetId: 'custom-x' });
  assert.equal(state.restore(oldCustom, model, newId).selectedPresetId, 'custom-x', 'own timelines stay selected');
  const chosen = state.serialize({ params: model.base, presets: [], selectedPresetId: 'builtin-bold', range: null });
  assert.equal(state.restore(chosen, model, newId).selectedPresetId, 'builtin-bold', 'a template the user picked is kept');
});

test('move transfers a saved state to a new id without overwriting', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  storage.setItem(state.key('video-1'), 'A');
  state.move(storage, 'video-1', 'file:a.mp4');
  assert.equal(storage.getItem(state.key('file:a.mp4')), 'A');
  assert.equal(storage.getItem(state.key('video-1')), null);
  storage.setItem(state.key('video-2'), 'B');
  state.move(storage, 'video-2', 'file:a.mp4');
  assert.equal(storage.getItem(state.key('file:a.mp4')), 'A', 'an existing state is kept');
});
