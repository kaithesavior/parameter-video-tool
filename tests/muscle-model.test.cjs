const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const muscle = require('../muscle-model.js');

test('effort grows with elbow load and is highest while lifting', () => {
  const straight = muscle.estimateEffort(0, 0).effort;
  const bent = muscle.estimateEffort(90, 0).effort;
  assert.ok(Math.abs(straight - muscle.EFFORT.resting) < 1e-9, 'straight arm = resting effort');
  assert.ok(bent > straight);
  const lifting = muscle.estimateEffort(90, 60),
    lowering = muscle.estimateEffort(90, -60);
  assert.equal(lifting.phase, 'lifting');
  assert.equal(lowering.phase, 'lowering');
  assert.equal(lifting.effort, 1);
  assert.ok(lowering.effort < lifting.effort);
});

test('effort stays within 0–1 for out-of-range angles', () => {
  for (const angle of [-40, 0, 45, 90, 150, 400]) {
    for (const velocity of [-500, 0, 500]) {
      const { effort } = muscle.estimateEffort(angle, velocity);
      assert.ok(effort >= 0 && effort <= 1, `${angle}° ${velocity}°/s → ${effort}`);
    }
  }
});

test('small velocities count as holding', () => {
  assert.equal(muscle.phaseOf(5), 'holding');
  assert.equal(muscle.phaseOf(-5), 'holding');
});

const tiny = (frames, regions = 1) => ({
  version: 1,
  fps: 10,
  frameCount: frames.length,
  regions: Array.from({ length: regions }, (_, i) => ({ id: 'r' + i, label: 'R' + i })),
  frames,
});
const square = [0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3];

test('outlinesAt maps time to the nearest frame and skips hidden regions', () => {
  const doc = muscle.validateDocument(
    tiny(
      [
        [square, null],
        [null, square],
        [square, square],
      ],
      2,
    ),
  );
  assert.equal(muscle.frameIndexAt(doc, 0.14), 1);
  assert.equal(muscle.frameIndexAt(doc, -5), 0);
  assert.equal(muscle.frameIndexAt(doc, 99), 2);
  assert.equal(muscle.outlinesAt(doc, 0).length, 1);
  assert.equal(muscle.outlinesAt(doc, 0.2).length, 2);
});

test('outlineCenter works in pixels', () => {
  const { x, y, reach } = muscle.outlineCenter(square, 1000, 500);
  assert.equal(Math.round(x), 200);
  assert.equal(Math.round(y), 100);
  assert.equal(Math.round(reach), Math.round(Math.hypot(100, 50)));
});

test('validateDocument rejects malformed documents', () => {
  assert.throws(() => muscle.validateDocument(null));
  assert.throws(() => muscle.validateDocument({ ...tiny([[square]]), version: 2 }));
  assert.throws(() => muscle.validateDocument({ ...tiny([[square]]), frameCount: 3 }));
  assert.throws(() => muscle.validateDocument(tiny([[square, square]])), 'region count mismatch');
  assert.throws(() => muscle.validateDocument(tiny([[[0.1, 0.2, 1.5, 0.2, 0.3, 0.3]]])), 'out of 0–1');
  assert.throws(() => muscle.validateDocument(tiny([[[0.1, 0.2, 0.3]]])), 'odd length');
});

test('the generated biceps mask is valid and covers the demo clip', () => {
  const file = path.join(__dirname, '..', 'assets', 'biceps-mask.json');
  const doc = muscle.validateDocument(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(doc.source, 'assets/biceps-source.mov');
  assert.equal(doc.regions.length, 2);
  const visible = doc.frames.flat().filter(Boolean).length;
  assert.ok(visible / (doc.frameCount * 2) > 0.95, `only ${visible} outlines visible`);
});
