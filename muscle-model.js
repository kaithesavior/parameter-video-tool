// Biceps highlight logic shared by the browser (muscle.js) and the tests.
//   - estimateEffort: approximate biceps effort from elbow movement (no muscle sensor needed)
//   - outlinesAt:     the biceps outlines for a video time, from assets/biceps-mask.json
(function (root) {
  'use strict';

  // ----- Effort estimate -------------------------------------------------------
  // With the upper arm hanging vertically, the weight's turning force on the elbow
  // grows with sin(elbow angle): smallest with the arm straight, largest at 90°.
  // Lifting (concentric) needs more activation than lowering (eccentric).
  // This is a teaching approximation, not a measurement.
  const EFFORT = {
    resting: 0.12, // holding the weight with a straight arm still takes some effort
    lifting: 1, // phase multipliers
    holding: 0.8,
    lowering: 0.65,
    phaseThreshold: 12, // deg/s; slower than this counts as holding
  };

  function phaseOf(velocityDegPerSec) {
    if (velocityDegPerSec > EFFORT.phaseThreshold) return 'lifting';
    if (velocityDegPerSec < -EFFORT.phaseThreshold) return 'lowering';
    return 'holding';
  }

  function estimateEffort(elbowDeg, velocityDegPerSec) {
    const angle = Math.min(150, Math.max(0, elbowDeg));
    const phase = phaseOf(velocityDegPerSec);
    const load = Math.sin((angle * Math.PI) / 180);
    const effort = EFFORT.resting + (1 - EFFORT.resting) * load * EFFORT[phase];
    return { effort: Math.min(1, Math.max(0, effort)), phase };
  }

  // ----- Outline document ------------------------------------------------------
  // { version: 1, fps, frameCount, width, height, regions: [{id, label}],
  //   frames: [[outline | null, …per region], …per frame] }
  // An outline is a flat [x0, y0, x1, y1, …] list normalized to 0–1.

  function validateDocument(doc) {
    if (!doc || doc.version !== 1) throw new Error('Unsupported mask document version.');
    if (!(doc.fps > 0) || !Number.isInteger(doc.frameCount) || doc.frameCount < 1)
      throw new Error('Mask document needs fps and frameCount.');
    if (!Array.isArray(doc.regions) || !doc.regions.length) throw new Error('Mask document has no regions.');
    if (!Array.isArray(doc.frames) || doc.frames.length !== doc.frameCount)
      throw new Error('Mask frame count does not match frameCount.');
    for (const frame of doc.frames) {
      if (!Array.isArray(frame) || frame.length !== doc.regions.length)
        throw new Error('Each mask frame needs one entry per region.');
      for (const outline of frame) {
        if (outline !== null && !isOutline(outline)) throw new Error('Invalid outline in mask document.');
      }
    }
    return doc;
  }

  function isOutline(outline) {
    return (
      Array.isArray(outline) &&
      outline.length >= 6 &&
      outline.length % 2 === 0 &&
      outline.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    );
  }

  function frameIndexAt(doc, seconds) {
    const index = Math.round(seconds * doc.fps);
    return Math.min(doc.frameCount - 1, Math.max(0, index));
  }

  // Outlines present at a video time; regions hidden in that frame are skipped.
  function outlinesAt(doc, seconds) {
    return doc.frames[frameIndexAt(doc, seconds)].filter(Boolean);
  }

  // Center and reach of an outline in pixels, for placing the glow.
  function outlineCenter(outline, width, height) {
    let x = 0,
      y = 0;
    const count = outline.length / 2;
    for (let i = 0; i < outline.length; i += 2) {
      x += outline[i] * width;
      y += outline[i + 1] * height;
    }
    x /= count;
    y /= count;
    let reach = 0;
    for (let i = 0; i < outline.length; i += 2) {
      reach = Math.max(reach, Math.hypot(outline[i] * width - x, outline[i + 1] * height - y));
    }
    return { x, y, reach };
  }

  const api = { EFFORT, phaseOf, estimateEffort, validateDocument, frameIndexAt, outlinesAt, outlineCenter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MuscleModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
