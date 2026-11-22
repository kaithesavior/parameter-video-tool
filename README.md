# Parameter Video Tool

A local teaching tool that adapts an exercise video to a learner: its playback speed, zoom and focus are set by hand, follow a cue timeline, or follow live input, such as a learner tracked by the Stickies sensors.

## Pipeline at a glance

```
learner sticky data ─┐   ┌─────────────────────────┐  parameters   ┌──────────────┐   ┌─────────────────┐
(stickies.csv)       ├──>│ 1. Stickies bridge      │──────────────>│ 2. Local     │──>│ 3. Editor       │──> adaptive video
demo MediaPipe data ─┘   │    (Python)             │ cue timeline  │    server    │   │    (browser)    │    (MP4 / WebM)
(reference.csv, video)   │    Video-Sticky-        │ JSON, or live │    (Node.js) │   │                 │
                         │    Algorithms trackers  │ POST /input   └──────────────┘   └─────────────────┘
                         └─────────────────────────┘
```

| Part | Input | Output | Framework |
| --- | --- | --- | --- |
| [1. Stickies bridge](#part-1-stickies-bridge) | Learner sticky (IMU) session, the demo's MediaPipe angles, the demo video | Cue timeline JSON (offline) or live parameter messages to `POST /input` | Python 3.10+, numpy, pandas, MediaPipe Tasks, OpenCV, trackers from [Video-Sticky-Algorithms](https://github.com/kaithesavior/Video-Sticky-Algorithms) |
| [2. Local server](#part-2-local-server) | HTTP requests from the bridge, scripts and the editor | The editor's files, videos, a live event stream (`GET /live`) | Node.js 20+ built-in modules only (`node:http`, `node:fs`) |
| [3. Editor](#part-3-editor) | Videos, cue timeline / parameters JSON, live events, the user's edits | The edited view, and exports: video (MP4 / WebM), cue timeline (CSV / JSON), parameters (JSON) | Plain HTML, CSS and JavaScript (no framework, no build step), Canvas 2D, MediaRecorder, Web Audio, Server-Sent Events |

The formats passed between the parts are described in [Data formats](#data-formats).

## Run

- **Editor only:** install Node.js 20 or later, run `npm start` and open http://127.0.0.1:4173. No npm dependencies are needed. There is no built-in video: import one, or copy videos into `videos/`. The editor opens the last video watched, or the first in the library.
- **With the Stickies bridge:** once, run `npm run setup:stickies` (needs Python 3.10+ and git). It clones Video-Sticky-Algorithms into `vendor/` (ignored by git) and installs numpy, pandas, mediapipe and opencv-python. Then use `npm run stickies -- <command>` (see Part 1).

## Part 1: Stickies bridge

Folder `stickies_bridge/`. It finds where in the demo video the learner is at every moment and turns that into speed, zoom and focus.

| | |
| --- | --- |
| **Input** | A learner session folder: `stickies.csv` (sticky IMU samples), a calibration file (`imu.json`, `session.json` or `take.json`), and the demo's `reference.csv` (MediaPipe angles), `reference.json` and video (e.g. `curls.mp4`) next to it or one folder up. `truth.csv` is optional (dummy data only). |
| **Output** | Offline: a cue timeline JSON, a per-sample parameters CSV and a report JSON in `output/stickies/<session>/`. Live: JSON messages sent to the editor's `POST /input` at 30 Hz. |
| **Framework** | Python 3.10+ with numpy and pandas; MediaPipe Tasks (PoseLandmarker) and OpenCV for pose; the tracking algorithms of Video-Sticky-Algorithms (imported from `vendor/Video-Sticky-Algorithms`, or `--algorithms DIR` / `STICKIES_ALGORITHMS=DIR`); argparse CLI; urllib for HTTP. |

### Stages

| Stage (file) | Input | Output |
| --- | --- | --- |
| 1. Load session (`session.py`) | `stickies.csv` (`sensor_name`, `t_s`, `tilt_deg`), calibration (sticky → `demo_column`), `reference.csv` (`time_s`, one angle column per segment), `reference.json` (`video`) | The learner's angle of one segment (default `right_forearm_elev_deg`, `--segment`) over learner time, and the demo's angle of it over demo time |
| 2. Track (`trackers.py`) | The two angle series | Track: the learner's position in the demo (`demo_s`) at each learner time, 20 samples per second |
| 3. Pose (`pose.py`) | The demo video and the MediaPipe model `Mediapipe/pose_landmarker_full.task` from Video-Sticky-Algorithms | `<video>_<side>_pose.csv`: `time_s`, `detected`, shoulder / elbow / wrist `_x`, `_y` (% of the frame) and `_vis`, cached in `output/stickies/` |
| 4. Parameters (`parameters.py`) | Track, demo angles, pose | Samples: `t`, `demo_s`, `speed`, `zoom`, `x`, `y`, `error_deg` per learner sample |
| 5a. Cue timeline (`timeline.py`) | Samples, demo length, demo video name | Cue timeline JSON (`stickies-preset` v1, at most 100 cues on the video's clock) |
| 5b. Live sender (`live.py`) | Samples (computed with backward-looking windows only) | `POST /input` messages `{seq, time, speed, zoom, x, y, video, source}` in real time |

**Trackers** (stage 2, `--tracker`, default `gvf`):

| Tracker | Method | Uses | Mean position error on the curls dummy data |
| --- | --- | --- | --- |
| `gvf` | GVF particle filter, the deployed live tracker | past samples only (streaming) | 0.3–0.5 s |
| `hmm` | Hidden Markov Model over positions in the demo: each step the learner stays or moves forward (forward filter; `sigma`, `stay`, `max_step`) | past samples only (streaming); never moves backward | 0.2–0.5 s |
| `dtw-online` | streaming DTW with a short lookahead (`lag`) | past samples + 0.2 s | 0.6–0.8 s |
| `dtw` | offline DTW, the optimal warping path | the whole recording | 0.45–0.6 s |
| `truth` | `truth.csv` of the dummy data | the answer itself; checks the rest of the pipeline | 0 |

Hyperparameters pass through with `--param name=value`. Video-Sticky-Algorithms' own `predict()` methods return predicted angles for benchmarking and build their template from `truth.csv`; the bridge runs the same matching code against the demo's own reference instead, so no ground truth is used (except by `truth`). The repository's HiddenMarkov decodes the learner's *angle* (its hidden states are angle values), so it cannot tell where in the demo the learner is; `hmm` applies the same method (Gaussian angle emissions, forward recursion, `sigma`) with demo positions as the hidden states, and is implemented in the bridge.

**Parameter mapping** (stage 4):

| Parameter | From |
| --- | --- |
| `speed` | the learner's pace: demo seconds per learner second over a 2 s window (`--pace-window`), so the video plays as fast as the learner moves; 0.25–3× |
| `x`, `y` | the moving body part (default forearm, `--focus-on`) in the demo frame, from the pose at the learner's position |
| `zoom` | a steady close-up on that part (1.6×, `--zoom`); with `--error-zoom DEG`, closer (`--zoom-max`, 2.5×) while the learner's angle is that far from the demo's |
| `time` (live only) | the learner's position in the demo, which the video follows |
| `video` (live only) | the demo video's file name, so the editor applies the values only while that video is open |

`--pose none` skips the pose: focus stays centred and zoom at 1×. Even at the true position, the sticky's forearm angle and MediaPipe's differ by about 30° on average, so `--error-zoom` needs a high threshold, and it is off by default.

### Commands

| Command | Input | Output |
| --- | --- | --- |
| `npm run stickies -- timeline <session> [--install]` | a session folder | `output/stickies/<session>/<session>_<tracker>.json` (cue timeline), `…_samples.csv`, `…_report.json`; `--install` copies the demo video into `videos/` |
| `npm run stickies -- live <session>` | a session folder; the editor open in Live mode | live messages to `--url` (default `http://127.0.0.1:4173/input`); `--replay-speed`, `--loop`, `--dry-run` (print instead of send) |
| `npm run stickies -- evaluate <session>` | a session folder with `truth.csv` | a table of each tracker's position error (mean, 90th percentile, max) |
| `npm run stickies -- pose <video>` | a demo video | a pose CSV for `--pose FILE` |

Example, offline (the adaptive video for a recorded session):

```sh
npm run stickies -- timeline vendor/Video-Sticky-Algorithms/stickies_playback/dummy_data/curls/x1.50 --install
```

In the editor, **Import** the JSON (it opens `curls.mp4` from the library), choose **Cues**, press Play; **Export → Video** records the adaptive video.

Example, live:

```sh
npm start        # terminal 1; in the editor open curls.mp4, choose Live, press Play
npm run stickies -- live vendor/Video-Sticky-Algorithms/stickies_playback/dummy_data/curls/x1.50   # terminal 2
```

The session is replayed in real time. Streaming trackers use only the past (plus `dtw-online`'s short lookahead), so this matches running them on a live sticky stream.

## Part 2: Local server

File `server/server.cjs`, started with `npm start`. Everything stays on this computer (it listens on 127.0.0.1 only).

| | |
| --- | --- |
| **Input** | HTTP requests: `POST /input` (live parameter JSON from the bridge or any program), `POST /api/videos?name=…` (a video file uploaded by the editor), `DELETE /api/videos/<name>`, and `GET` for the editor's files and videos |
| **Output** | The editor's files from `public/`; videos from `videos/` with byte ranges (for seeking); `GET /api/videos` (JSON list of videos); `GET /live` (Server-Sent Events stream of validated live messages); uploaded videos saved in `videos/` |
| **Framework** | Node.js 20+ with built-in modules only (`node:http`, `node:fs`, `node:path`, `node:crypto`); shares `public/js/model/live-input.js` with the editor for validating live messages |

| Endpoint | Input | Output |
| --- | --- | --- |
| `POST /input` | JSON live message or an array of up to 64; `Content-Type: application/json` required | `202 {ok, accepted, listeners}`, or `400` / `413` / `415` with an error |
| `GET /live` | — | Server-Sent Events: one validated message per event |
| `GET /api/videos` | — | `[{name, size, modified}]` |
| `POST /api/videos?name=…` | raw video bytes (`.mp4`, `.m4v`, `.webm`, `.mov`, `.ogv`) | `201 {ok, name, size}` with the saved name (`name (2).mp4` if a different file has that name) |
| `DELETE /api/videos/<name>` | — | `204` |
| `GET /videos/<name>`, `GET /index.html`, `/style.css`, `/js/…` | — | the file (other paths: `404`) |

`VIDEOS_DIR=/some/folder npm start` uses another videos folder; `PORT=4174 npm start` another port.

## Part 3: Editor

Folder `public/`, opened at http://127.0.0.1:4173.

| | |
| --- | --- |
| **Input** | Videos (any format the browser plays), cue timeline and parameters JSON files, live messages (from the server's `GET /live`, or `window.StickiesLive.push()` in the page), the user's edits |
| **Output** | The edited view (speed, zoom, focus) on screen; exports: the edited video (MP4 or WebM, with audio), cue timeline (CSV or JSON), view parameters (JSON); each video's workspace saved in the browser |
| **Framework** | Plain HTML, CSS and JavaScript, no framework or build step. HTML5 `<video>` for playback, Canvas 2D for zoom and focus, MediaRecorder + `canvas.captureStream()` + Web Audio for video export, EventSource (Server-Sent Events) for live input, localStorage for workspaces |

### Screen

| Area | What it is for |
| --- | --- |
| Toolbar | **Import** (videos and JSON files) and **Export** (video, cue timeline CSV / JSON, view parameters) |
| Videos (left) | The video library |
| Viewer (centre) | The edited view, play / pause, and read-outs of the current speed and zoom |
| Timeline (bottom) | The selected cue timeline; click or drag to move the playhead, click a cue block to select that cue |
| Inspector (right) | **Control** → **View** → **Cue timelines**, top to bottom in the order of work |

### Control: Manual, Cues or Live

Exactly one source drives speed, zoom and focus, chosen under **Control**:

| Mode | Input | Output |
| --- | --- | --- |
| **Manual** | the values in **View** (speed 0.25–3×, zoom 1–5×, focus, optional zoom animation) | the view |
| **Cues** | the selected cue timeline; values ease between cues | the view, changing as the video plays |
| **Live** | live messages (see [Live message](#live-message)) | the view, and with `time`, the video's position |

In Cues or Live mode, View shows the values being applied (marked *driven*). Editing View, the focus map or the picture switches back to Manual so the edit sticks. Play, the timeline and cue selection never change the mode.

### Video library

- **Input:** video files, from **Import** (several at once) or copied into `videos/`.
- **Output:** the files saved in `videos/` by the server, listed in the **Videos** sidebar.

Click a video to open it; **×** removes one, **Clear** removes all imported videos (the files are deleted after a confirmation). Removing the open video opens another one; with an empty library the viewer shows **No video**, and Play, Export and New timeline need a video first. Importing the same file twice reuses it. `videos/` is ignored by git. If the server cannot save a video (for example the page was not opened through `npm start`), it is kept for this session only and marked as such. Videos from earlier versions, which kept them inside the browser, are moved into `videos/` automatically, together with their saved settings.

### Per-video workspace

- **Input:** the work done on a video: View values (speed, zoom, focus, zoom animation), cue timelines, the selected timeline, the export range.
- **Output:** saved in this browser's localStorage, per video, and restored when the video is opened again, also after a reload.

A newly added video starts empty: View is neutral (1×, no zoom, centred focus) and no cue timeline is selected. Removing a video removes its saved work too. The three built-in timelines are shared, read-only templates that are never applied automatically; select one, or **Duplicate** it to make an editable copy. If saved work is damaged, the rest still loads and the original is copied to a `.backup` key (the status bar says which).

### Cue timelines

- **Input:** View values, captured into cues (Manual mode), or an imported cue timeline file.
- **Output:** the timeline used by Cues mode, shown on the timeline bar.

**New** starts a timeline from the current View; **Duplicate** copies a template or another timeline; **Delete** removes it. Click a cue (in the list or on the timeline) to move the playhead there; in Manual mode its values are loaded into View. Adjust View, then **Update** saves the values into the selected cue, or **Add cue** adds one at the time given.

### Import

- **Input:** videos, a [cue timeline file](#cue-timeline-file) or a [parameters file](#parameters-file) (the type is detected from the content). Select a JSON file and a video together to open them together.
- **Output:** the video opens; a timeline is added to the video it belongs to; a parameters file sets View.

### Live input

- **Input:** [live messages](#live-message) from `POST /input` (relayed by the server), or `window.StickiesLive.push({...})` from in-page sources (Web Serial, WebHID, Web MIDI).
- **Output:** speed, zoom and focus applied every frame; with `time`, the video follows that position.

```sh
curl -X POST http://127.0.0.1:4173/input -H 'Content-Type: application/json' \
  -d '{"seq": 1, "speed": 0.5, "zoom": 2, "x": 60, "y": 45}'
```

- In Live mode, Play needs live input for the open video. With none arriving (no stream running, or it stopped more than 1 s ago), with input meant for another video, or without the server, Play is refused and the status bar says why. Choose Manual to play without live input.
- Live input is only connected in Live mode. `window.StickiesLive.enable()` / `.disable()` switch modes from code. Editing View switches to Manual; choose Live again to follow the input.
- Values are smoothed (80 ms) so sensor jitter does not shake the picture. Out-of-order `seq` values are dropped. After 1 s without data the badge shows **Stale** and the last values are held.
- With `time`, the video speeds up or slows down to stay on that position while playing (moving on at the sent `speed` between messages), and jumps when it is 1.5 s or more off (not during export). **Following** in the Live panel shows the video's offset from it.
- Live input keeps working during export, so a live session can be recorded.
- The browser reconnects to `GET /live` automatically.

### Export

- **Input:** the open video and its View, cue timeline and export range.
- **Output:** a file download:

| Export | Output |
| --- | --- |
| **Video** | the edited view and the source audio, recorded in real time as MP4 (H.264 / AAC) where the browser supports it, otherwise WebM, at the chosen resolution and range. Keep the page visible; the toolbar button cancels a running export. |
| **Cue timeline → CSV** | the selected timeline sampled every 0.1 s, including the end: time, cue labels, zoom, focus, speed and animation settings |
| **Cue timeline → JSON** | a [cue timeline file](#cue-timeline-file), with `time` and `video` |
| **View parameters** | a [parameters file](#parameters-file) with the current View values |

## Data formats

### Parameters

Used by cue timelines, parameters files and live messages.

| Field | Type | Range | Default | Meaning |
| --- | --- | --- | --- | --- |
| `speed` | number | 0.25–3 | 1 | Playback speed |
| `zoom` | number | 1–5 | 1 | Zoom factor |
| `x`, `y` | number | 0–100 | 50 | Focus, % of frame width / height from the top left |
| `animate` | boolean | | false | Zoom animation (parameters file only; cue timelines ignore it) |
| `start`, `end` | number | 0–36000 s | 0, 3 | Zoom animation start and end; `end` must be after `start` |

Every field is optional; missing ones use the default (a cue does not inherit the previous cue's values). Wrong types and out-of-range values are rejected with a message naming the cue or field. Unknown fields are ignored.

### Cue timeline file

Written by the bridge (`timeline`) and by **Export**, read by **Import**. Example: `examples/biceps-curl.json`.

```json
{
  "kind": "stickies-preset",
  "version": 1,
  "video": "curls.mp4",
  "preset": {
    "name": "Biceps curl walkthrough",
    "cues": [
      { "time": 0, "label": "Full view", "parameters": { "speed": 1, "zoom": 1 } },
      { "time": 2, "label": "Close-up, slow", "parameters": { "speed": 0.5, "zoom": 2.5, "x": 50, "y": 55 } }
    ]
  }
}
```

- `kind` and `version` must be exactly as shown. Files must be under 1 MB.
- `video` (optional) names the video the cue times belong to:
  - a path on this server (such as `videos/clip.mp4`) or a full URL is loaded automatically;
  - a file name (or a local path, of which only the name is used) must match the open video, a video in the library, or the video selected together with the JSON. Browsers cannot open local paths on their own.
  - Without `video`, the open video is used.
- `name`: 1–80 characters. `cues`: 1–100 cues.
- Each cue needs a `label` (1–80 characters), `parameters`, and a position:
  - `time`: seconds into the video (0 to the video length), or
  - `at`: fraction of the video length (0–1), stretched to whatever video is open. Older files use this.
  - `time` wins if both are given. The first cue must be at 0, and cues must be at least 1 ms apart.
- On reaching a cue, values ease to its parameters over at most 0.35 s.

### Parameters file

Written by **Export → View parameters**, read by **Import**.

```json
{ "version": 1, "parameters": { "speed": 0.5, "zoom": 2, "x": 60, "y": 45 } }
```

### Live message

Sent by the bridge (`live`) or any program to `POST /input`, relayed to the editor.

```json
{ "seq": 12, "time": 4.25, "speed": 1.4, "zoom": 1.6, "x": 41.2, "y": 38.5, "video": "curls.mp4", "source": "hmm · curls-x1.50" }
```

| Field | Range | Meaning |
| --- | --- | --- |
| `speed`, `zoom`, `x`, `y` | as in [Parameters](#parameters) | view values; out-of-range values are clamped |
| `time` | 0–36000 s | a position in the video to follow, such as where the learner is in the demo |
| `video` | text, 1–200 characters | the video the values are for (a file name; for a path, its last part is compared). Messages for another video are not applied, and the Live badge shows **Other video**. Without `video`, values apply to whichever video is open |
| `source` | text, 1–80 characters | what produces the values, e.g. the tracker and session (`hmm · curls-x1.50`). Shown as **Source** in the Live panel (marked *stopped* when input stops); not applied |
| `seq` | integer ≥ 0 | increasing; older messages are dropped |

Every field is optional, but a message needs at least one of `speed`, `zoom`, `x`, `y`, `time`. Other fields are ignored. Non-numbers (and a `video` that is not text) are rejected with HTTP 400. Opening another video drops the live values received for the previous one.

### Bridge input files

| File | Columns / keys |
| --- | --- |
| `stickies.csv` | `sensor_name`, `t_s` (learner seconds), `tilt_deg` (sticky angle); other columns are ignored |
| `imu.json` / `session.json` / `take.json` | `stickies` (or `calibration.stickies`): sensor name → `{"demo_column": "<segment>"}` |
| `reference.csv` | `time_s` (demo seconds), one angle column per segment, e.g. `right_forearm_elev_deg` |
| `reference.json` | `video`: the demo video's file name, next to `reference.csv` |
| `truth.csv` (optional) | `t_s`, `demo_s`: where the learner really was (dummy data) |

## Tests

| Command | Input | Output | Framework |
| --- | --- | --- | --- |
| `npm test` | `tests/unit/` | pass / fail per test | Node.js built-in test runner (`node:test`) |
| `npm run test:bridge` | `stickies_bridge/tests/` (dummy-data tests are skipped without `vendor/`) | pass / fail per test | Python `unittest` (also runs the editor's timeline parser through Node) |
| `npm run test:e2e` | `tests/e2e/browser.mjs` | PASS / FAIL per check, console errors | headless Chrome over the DevTools Protocol, no npm dependencies (set `CHROME_PATH` if Chrome is elsewhere) |
| `npm run test:all` | all of the above | | |

## Project layout

```
public/                  Part 3, the editor: everything the browser loads (the only folder the server serves, besides videos/)
  index.html             the editor page
  style.css
  js/model/              pure logic, also used by the server and the tests
    preset-model.js        cue timeline validation, interpolation and the JSON file format
    video-state.js         saving and restoring each video's workspace
    live-input.js          live message validation, ordering, smoothing, staleness and position following
    schedule-export.js     cue timeline CSV
  js/ui/                 the editor
    app.js                 playback, the Control mode, View (zoom and focus) and video export
    library.js             the video library sidebar, backed by the videos folder
    presets.js             cue timelines, Cues mode, the timeline panel and the per-video workspace
    live.js                Live mode: the live input connection, position following and status
server/server.cjs        Part 2, the local server
stickies_bridge/         Part 1, the Python bridge (stages listed in Part 1)
  cli.py                   the commands (timeline, live, evaluate, pose)
  tests/
examples/biceps-curl.json  example cue timeline for curls.mp4
tests/unit/              Node unit and server tests
tests/e2e/browser.mjs    browser tests
tests/fixtures/sample.mov  the test video (used by the tests only, not served)
```

Not in git: `videos/` (videos imported in the editor), `vendor/Video-Sticky-Algorithms` (`npm run setup:stickies`), `output/stickies/` (bridge output and the cached demo pose).

| Command | What it does |
| --- | --- |
| `npm start` | run the server and editor at http://127.0.0.1:4173 |
| `npm run setup:stickies` | clone Video-Sticky-Algorithms and install the bridge's Python packages |
| `npm run stickies -- <command>` | the bridge: `timeline`, `live`, `evaluate`, `pose` |
| `npm test`, `npm run test:bridge`, `npm run test:e2e`, `npm run test:all` | the tests |
| `npm run format` | apply the code style (.prettierrc.json, .editorconfig) |

Videos are processed locally. This repository does not grant rights to third-party footage or branding.
