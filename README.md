# Parameter Video Tool

A local teaching tool for playback speed, zoom, focus and timed presets. Stickies events are simulated; no sensor hardware is connected.

## Run

Install Node.js 20 or later, run `npm start`, and open http://127.0.0.1:4173. No npm dependencies are required. The example video loads automatically. Other browser-compatible videos can be imported.

## Controls

- Speed: 0.25x to 3x, with a persistent actual-speed readout.
- Zoom: 1x to 5x, focus X/Y percentages, and optional timed animation.
- Custom presets, timeline curves, and exact cue values.

Choose Play preset to start. Use New or Duplicate to create a preset, adjust parameters, then Add cue or Update cue. Manual changes detach the simulation. Presets are stored in browser local storage. Legacy files remain importable; unsupported fields are ignored.

## Live input (real-time parameters)

Any program can drive speed, zoom and focus while the editor is open. Turn on **Follow live parameters** in the inspector, then send JSON to the local server:

```sh
curl -X POST http://127.0.0.1:4173/input -H 'Content-Type: application/json' \
  -d '{"seq": 1, "speed": 0.5, "zoom": 2, "x": 60, "y": 45}'
```

- Fields are optional: `speed` 0.25–3, `zoom` 1–5, `x` and `y` 0–100 (% of frame), `elbow` 0–150 (degrees of elbow flexion, 0 = straight), `seq` an increasing integer. Out-of-range values are clamped. Non-numbers are rejected with HTTP 400. An array of up to 64 messages is accepted.
- The server relays messages to the page over Server-Sent Events (`GET /live`). The browser reconnects automatically.
- Values are smoothed (80 ms) so sensor jitter does not shake the picture. Out-of-order `seq` values are dropped. After 1 s without data the badge shows **Stale** and the last values are held.
- A manual edit or Play preset takes over speed, zoom and focus (badge: **Body only**). Elbow movement keeps driving the muscle highlight. Switch live input off and on to follow the view again.
- Live input keeps working during export, so a live session can be recorded.
- `npm run simulate` sends synthetic sensor data at 30 Hz. Options: `-- --rate 60`, `-- --fields elbow` (only arm movement).
- In-page sources (Web Serial, WebHID, Web MIDI) can call `window.StickiesLive.push({zoom: 2})` and go through the same path.
- The endpoint requires `Content-Type: application/json`, so other websites cannot drive the player from the browser.

## Muscle highlight

The biceps on the example clip glow with estimated effort. Stickies only measures movement, so effort is **estimated from the elbow angle**, not measured:

- Load on the biceps grows with sin(elbow angle): lowest with the arm straight, highest at 90°.
- Lifting counts fully, holding 80%, lowering 65%. A straight arm still shows 12% (holding the weight).
- Without live elbow data, the **Intensity** slider sets the glow.

The outlines are traced once, offline, and stored in `assets/biceps-mask.json`:

1. **SAM 2** (Meta, Apache 2.0) tracks each whole arm through the clip with pixel-exact edges.
2. **MediaPipe Pose** (Google, Apache 2.0) finds the shoulder and elbow in every frame.
3. The biceps is the arm mask inside an ellipse along the shoulder→elbow line (below the deltoid, above the elbow crease).

To regenerate, for example after changing `tools/muscle-mask/prompts.json`:

```sh
python3 -m venv .venv && .venv/bin/pip install -r tools/muscle-mask/requirements.txt
.venv/bin/python tools/muscle-mask/extract_mask.py --preview mask-preview.jpg --cache arm-cache.npz
```

SAM 2 takes about 5 minutes on an Apple M3. Models download to `~/.cache/stickies-muscle-mask`. With `--cache`, later runs reuse the tracked arms and finish in seconds. The highlight only appears on the video the outlines were traced on.

## Export

CSV samples the selected preset every 0.1 source seconds, including the endpoint, with source time, cue labels, zoom, focus, speed and animation settings. It describes the preset schedule, not a recording of manual edits. JSON preserves an importable preset.

Video export records canvas output and source audio in real time as MP4 or WebM. Choose resolution and source range under Export settings and keep the page visible during export.

## Files and tests

- index.html and style.css: English interface.
- app.js: playback, zoom, focus and video export.
- preset-model.js and presets.js: presets, interpolation and timeline.
- schedule-export.js: CSV generation.
- assets/biceps-source.mov: original exercise video.
- server.cjs: local server with video range support and the live input relay.
- live-input.js: live message validation, ordering, smoothing and staleness (shared by server and browser).
- live.js: live input connection and inspector panel.
- muscle-model.js: effort estimate and outline lookup (shared with tests).
- muscle.js: biceps highlight drawing and inspector panel.
- assets/biceps-mask.json: biceps outlines for the example clip.
- tools/muscle-mask/: offline outline generator (SAM 2 + MediaPipe Pose).
- tools/simulate-input.cjs: synthetic live input sender.
- tests/: run with `npm test`.

Videos are processed locally. This repository does not grant rights to third-party footage or branding.
