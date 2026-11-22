"""Bridge tests: python3 -m unittest discover -s stickies_bridge/tests -t .  (npm run test:bridge)

Synthetic sessions test the mapping without any data. Tests on the Video-Sticky-Algorithms
dummy data are skipped when vendor/Video-Sticky-Algorithms is missing.
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import subprocess
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from stickies_bridge.live import messages
from stickies_bridge.parameters import Mapping, pace, parameter_samples
from stickies_bridge.session import BridgeError, Session, load_session
from stickies_bridge.timeline import MAX_CUES, build_timeline
from stickies_bridge.trackers import DEFAULT_ALGORITHMS_DIR, Track, run_tracker, tracking_error

ROOT = Path(__file__).resolve().parents[2]
DUMMY = DEFAULT_ALGORITHMS_DIR / "stickies_playback" / "dummy_data" / "curls"
NODE = shutil.which("node")


def synthetic(speed: float, demo_len: float = 20.0, start: float = 1.0) -> Session:
    """A demo of curls (one every 4 s) and a learner doing them `speed` times as fast."""
    ref_t = np.arange(0, demo_len, 1 / 30)
    ref = 90 - 80 * np.cos(2 * np.pi * ref_t / 4)
    learner_t = np.arange(0, (demo_len - start) / speed, 0.01)
    demo = start + speed * learner_t
    angle = 90 - 80 * np.cos(2 * np.pi * demo / 4)
    truth = pd.DataFrame({"t_s": learner_t, "demo_s": demo})
    return Session("synthetic", "seg", learner_t, angle, ref_t, ref, None, truth)


def tool_parse(data: dict, duration: float) -> dict:
    """Parses a cue timeline file with the tool's own PresetModel.fromFile."""
    script = (
        "const m = require(process.argv[1]); let s = '';"
        "process.stdin.on('data', c => (s += c)).on('end', () => {"
        "const p = m.fromFile(JSON.parse(s), Number(process.argv[2]));"
        "process.stdout.write(JSON.stringify(p)); });"
    )
    out = subprocess.run(
        [NODE, "-e", script, str(ROOT / "public" / "js" / "model" / "preset-model.js"), str(duration)],
        input=json.dumps(data), capture_output=True, text=True, check=False,
    )
    if out.returncode:
        raise AssertionError(out.stderr)
    return json.loads(out.stdout)


class MappingTests(unittest.TestCase):
    def test_pace_is_the_learner_speed(self):
        for speed in (0.5, 1.0, 1.5, 2.0):
            session = synthetic(speed)
            track = run_tracker("truth", session)
            for causal in (False, True):
                samples = parameter_samples(track, session, None, Mapping(), causal=causal)
                middle = samples[(samples.t > 2.5) & (samples.t < samples.t.max() - 2.5)]
                self.assertAlmostEqual(float(middle.speed.median()), speed, places=2)

    def test_pace_is_clamped_to_the_tool_range(self):
        t = np.arange(0, 5, 0.05)
        self.assertTrue(np.all(pace(t, t * 10, 1.0, False) == 3.0))
        self.assertTrue(np.all(pace(t, np.zeros_like(t), 1.0, False) == 0.25))

    def test_focus_follows_the_demo_position(self):
        session = synthetic(1.0)
        track = run_tracker("truth", session)
        focus = pd.DataFrame({"time_s": [0, 20], "x": [10, 90], "y": [50, 50]})
        samples = parameter_samples(track, session, focus, Mapping(), causal=False)
        self.assertAlmostEqual(float(np.interp(5.0, samples.t, samples.x)), 10 + 80 * 6 / 20, places=0)
        self.assertTrue((samples.zoom == 1.6).all(), "steady close-up when there is a focus")

    def test_error_zoom(self):
        session = synthetic(1.0)
        track = run_tracker("truth", session)
        off = Track("truth", track.t, track.demo_s, track.angle + 40 * (track.t > 10), streaming=False)
        samples = parameter_samples(off, session, None, Mapping(error_zoom_deg=20, zoom_max=2.5))
        self.assertEqual(float(samples[samples.t < 9].zoom.max()), 1.0)
        self.assertEqual(float(samples[samples.t > 11].zoom.min()), 2.5)


@unittest.skipIf(NODE is None, "node is not installed")
class TimelineTests(unittest.TestCase):
    def test_timeline_is_accepted_by_the_tool(self):
        session = synthetic(1.5)
        samples = parameter_samples(run_tracker("truth", session), session, None, Mapping())
        data = build_timeline(samples, session.demo_duration, "demo.mp4", "Stickies test")
        preset = tool_parse(data, session.demo_duration)
        self.assertEqual(preset["cues"][0]["at"], 0)
        self.assertEqual(data["video"], "demo.mp4")
        speeds = [c["parameters"]["speed"] for c in data["preset"]["cues"]]
        self.assertIn(1.5, speeds)

    def test_cue_limit(self):
        session = synthetic(1.0, demo_len=600)
        track = run_tracker("truth", session)
        rng = np.random.default_rng(0)
        wobbly = Track("x", track.t, track.demo_s, track.angle, False)
        samples = parameter_samples(wobbly, session, None, Mapping(pace_window_s=0.2))
        samples["x"] = rng.uniform(0, 100, len(samples))  # every bin differs
        data = build_timeline(samples, session.demo_duration, None, "many", step=0.1)
        self.assertLessEqual(len(data["preset"]["cues"]), MAX_CUES)
        tool_parse(data, session.demo_duration)

    def test_backwards_wobble_does_not_reorder_cues(self):
        session = synthetic(1.0)
        track = run_tracker("truth", session)
        wobble = track.demo_s - 0.8 * (np.sin(track.t * 3) > 0.9)
        samples = parameter_samples(Track("w", track.t, wobble, track.angle, False), session, None, Mapping())
        times = [c["time"] for c in build_timeline(samples, 20, None, "w")["preset"]["cues"]]
        self.assertEqual(times, sorted(set(times)))


class LiveTests(unittest.TestCase):
    def test_messages_report_the_current_position(self):
        session = synthetic(2.0)
        samples = parameter_samples(run_tracker("truth", session), session, None, Mapping(), causal=True)
        start, end, at = messages(samples, latency_s=0.2)
        message = at(4.0)
        self.assertEqual(set(message), {"time", "speed", "zoom", "x", "y"})
        # Reported 0.2 s late and moved on by the pace: still the position at 4.0 s.
        self.assertAlmostEqual(message["time"], 1.0 + 2.0 * 4.0, delta=0.05)
        self.assertLessEqual(start, 0.01)

    def test_messages_name_their_video(self):
        session = synthetic(1.0)
        samples = parameter_samples(run_tracker("truth", session), session, None, Mapping(), causal=True)
        self.assertEqual(messages(samples, 0.0, "curls.mp4")[2](3.0)["video"], "curls.mp4")
        self.assertNotIn("video", messages(samples, 0.0)[2](3.0))

    def test_messages_name_their_source(self):
        session = synthetic(1.0)
        samples = parameter_samples(run_tracker("truth", session), session, None, Mapping(), causal=True)
        self.assertEqual(messages(samples, 0.0, source="hmm · curls-x1.50")[2](3.0)["source"], "hmm · curls-x1.50")
        self.assertNotIn("source", messages(samples, 0.0)[2](3.0))


class CliTests(unittest.TestCase):
    def run_cli(self, *argv):
        from stickies_bridge.cli import main  # noqa: PLC0415

        with contextlib.redirect_stderr(io.StringIO()) as err, contextlib.redirect_stdout(io.StringIO()):
            try:
                code = main(list(argv))
            except SystemExit as exc:  # argparse rejects bad options
                code = exc.code
        return code, err.getvalue()

    def test_out_of_range_options_are_rejected(self):
        for option in (["--zoom", "9"], ["--pace-window", "0"], ["--cue-step", "0"], ["--zoom-max", "x"]):
            code, err = self.run_cli("timeline", "somewhere", *option)
            self.assertEqual(code, 2, option)
            self.assertIn(option[0], err)

    def test_missing_pose_file_is_a_clear_error(self):
        if not (DUMMY / "x1.00" / "stickies.csv").exists():
            self.skipTest("Video-Sticky-Algorithms not in vendor/")
        code, err = self.run_cli("timeline", str(DUMMY / "x1.00"), "--tracker", "truth", "--pose", "/no/such.csv")
        self.assertEqual(code, 2)
        self.assertIn("Pose file not found", err)


@unittest.skipUnless((DUMMY / "x1.00" / "stickies.csv").exists(), "Video-Sticky-Algorithms not in vendor/")
class DummyDataTests(unittest.TestCase):
    def test_hyperparameters_are_checked(self):
        session = load_session(DUMMY / "x1.00")
        with self.assertRaisesRegex(BridgeError, "Unknown gvf hyperparameter"):
            run_tracker("gvf", session, {"particle": 500})
        with self.assertRaisesRegex(BridgeError, "expected an integer"):
            run_tracker("gvf", session, {"particles": "abc"})
        with self.assertRaisesRegex(BridgeError, "Unknown dtw hyperparameter"):
            run_tracker("dtw", session, {"particles": 5})
        with self.assertRaisesRegex(BridgeError, "Unknown hmm hyperparameter"):
            run_tracker("hmm", session, {"particles": 5})

    def test_hmm_only_moves_forward(self):
        track = run_tracker("hmm", load_session(DUMMY / "x1.50"))
        self.assertGreaterEqual(float(np.diff(track.demo_s).min()), 0.0)
        self.assertTrue(track.streaming)

    def test_session_loads(self):
        session = load_session(DUMMY / "x1.50")
        self.assertEqual(session.segment, "right_forearm_elev_deg")
        self.assertEqual(session.video.name, "curls.mp4")
        self.assertIsNotNone(session.truth)

    def test_trackers_find_the_learner(self):
        session = load_session(DUMMY / "x1.00")
        for name, bound in (("truth", 0.01), ("gvf", 0.6), ("hmm", 0.5), ("dtw", 0.7), ("dtw-online", 0.9)):
            error = tracking_error(run_tracker(name, session), session)
            self.assertLess(error["mae_s"], bound, name)

    @unittest.skipIf(NODE is None, "node is not installed")
    def test_dummy_timeline_is_accepted_by_the_tool(self):
        session = load_session(DUMMY / "x2.00")
        samples = parameter_samples(run_tracker("gvf", session), session, None, Mapping())
        data = build_timeline(samples, session.demo_duration, session.video.name, "gvf x2")
        tool_parse(data, session.demo_duration)


if __name__ == "__main__":
    unittest.main()
