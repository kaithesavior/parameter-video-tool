'use strict';
// Biceps highlight.
// Draws the outlines from assets/biceps-mask.json (made offline by tools/muscle-mask)
// over the video, glowing with estimated effort. Effort comes from live elbow movement
// (Stickies, via live.js), or from the Intensity slider when no movement data arrives.

const MUSCLE_MASK_URL = 'assets/biceps-mask.json';
const MUSCLE_COLOR = '255, 72, 48';
const MUSCLE_LIVE_TIMEOUT_MS = 1000; // fall back to the slider after this much silence
const MUSCLE_SMOOTHING_MS = 120; // how quickly the glow follows effort changes
const MUSCLE_VELOCITY_DAMPING = 0.3; // 0–1, lower = steadier phase detection

const muscle = {
  enabled: true,
  doc: null,
  loadError: '',
  manualEffort: 0.6,
  effort: 0,
  elbow: null,
  velocity: 0,
  phase: 'holding',
  lastMotionAt: -Infinity,
  lastPaint: 0,
};

// ----- Mask document -------------------------------------------------------------

async function muscleLoadMask() {
  try {
    const response = await fetch(MUSCLE_MASK_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    muscle.doc = MuscleModel.validateDocument(await response.json());
  } catch (error) {
    muscle.loadError = error.message;
    console.warn('Biceps mask unavailable:', error.message);
  }
  musclePaint(true);
}

// The outlines were traced on one specific video.
function muscleMaskApplies() {
  return Boolean(muscle.doc) && !demo && video.currentSrc.endsWith('/' + muscle.doc.source);
}

// ----- Effort ----------------------------------------------------------------------

function muscleIsLive(now) {
  return now - muscle.lastMotionAt < MUSCLE_LIVE_TIMEOUT_MS;
}

// Called by live.js with the smoothed elbow angle (degrees) from Stickies.
function muscleMotion(elbowDeg, dtMs) {
  if (muscle.elbow !== null && dtMs > 0) {
    const velocity = (elbowDeg - muscle.elbow) / (dtMs / 1000);
    muscle.velocity += (velocity - muscle.velocity) * MUSCLE_VELOCITY_DAMPING;
  }
  muscle.elbow = elbowDeg;
  muscle.lastMotionAt = performance.now();
}

function muscleTargetEffort(now) {
  if (!muscleIsLive(now)) return muscle.manualEffort;
  const estimate = MuscleModel.estimateEffort(muscle.elbow, muscle.velocity);
  muscle.phase = estimate.phase;
  return estimate.effort;
}

// Called every frame by the render loop, before drawing.
function muscleFrame(dtMs) {
  const blend = 1 - Math.exp(-dtMs / MUSCLE_SMOOTHING_MS);
  muscle.effort += (muscleTargetEffort(performance.now()) - muscle.effort) * blend;
  musclePaint();
}

// ----- Drawing ---------------------------------------------------------------------

function musclePath(outline, width, height) {
  const path = new Path2D();
  path.moveTo(outline[0] * width, outline[1] * height);
  for (let i = 2; i < outline.length; i += 2) path.lineTo(outline[i] * width, outline[i + 1] * height);
  path.closePath();
  return path;
}

function muscleGlow(context, outline, width, height) {
  const { x, y, reach } = MuscleModel.outlineCenter(outline, width, height);
  const glow = context.createRadialGradient(x, y, 0, x, y, reach);
  const strength = muscle.effort;
  glow.addColorStop(0, `rgba(${MUSCLE_COLOR}, ${0.75 * strength})`);
  glow.addColorStop(0.65, `rgba(${MUSCLE_COLOR}, ${0.45 * strength})`);
  glow.addColorStop(1, `rgba(${MUSCLE_COLOR}, ${0.12 * strength})`);
  return glow;
}

// Called by draw() inside the zoom transform, so the glow follows zoom and focus.
function drawMuscleHighlight(context, width, height) {
  if (!muscle.enabled || muscle.effort < 0.01 || $('compare').checked || !muscleMaskApplies()) return;
  context.save();
  context.filter = `blur(${Math.max(1, Math.round(width * 0.004))}px)`;
  for (const outline of MuscleModel.outlinesAt(muscle.doc, time)) {
    context.fillStyle = muscleGlow(context, outline, width, height);
    context.fill(musclePath(outline, width, height));
  }
  context.restore();
}

// ----- Inspector panel ----------------------------------------------------------------

function muscleStateLabel(live) {
  if (!muscle.enabled) return { label: 'Off', tone: '' };
  if (!muscle.doc) return { label: 'No mask', tone: 'is-error' };
  if (!muscleMaskApplies()) return { label: 'Other video', tone: 'is-warn' };
  if (live) return { label: 'Stickies', tone: 'is-live' };
  return { label: 'Manual', tone: '' };
}

function musclePaint(force) {
  const now = performance.now();
  if (!force && now - muscle.lastPaint < 150) return;
  muscle.lastPaint = now;
  const live = muscleIsLive(now);
  const { label, tone } = muscleStateLabel(live);
  const badge = $('muscle-state');
  if (badge.textContent !== label) badge.textContent = label;
  badge.className = 'badge ' + tone;
  const percent = Math.round(muscle.effort * 100);
  $('muscle-effort-fill').style.width = percent + '%';
  $('muscle-effort-value').textContent = percent + '%';
  $('muscle-elbow').textContent = live ? Math.round(muscle.elbow) + '°' : '—';
  $('muscle-phase').textContent = live ? muscle.phase[0].toUpperCase() + muscle.phase.slice(1) : '—';
  $('muscle-intensity').disabled = live || !muscle.enabled || recording;
  $('muscle-source').textContent = live
    ? 'Estimated from Stickies elbow movement.'
    : 'Set by the Intensity slider.';
}

$('muscle-enable').addEventListener('change', () => {
  muscle.enabled = $('muscle-enable').checked;
  musclePaint(true);
});
$('muscle-intensity').addEventListener('input', () => {
  muscle.manualEffort = Number($('muscle-intensity').value) / 100;
  musclePaint(true);
});

$('muscle-enable').checked = muscle.enabled;
$('muscle-intensity').value = String(Math.round(muscle.manualEffort * 100));
void muscleLoadMask();
