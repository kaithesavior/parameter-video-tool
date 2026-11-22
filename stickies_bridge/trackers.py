"""Trackers: where in the demo video the learner is, at every learner moment.

The pattern matchers live in Video-Sticky-Algorithms. Their ``predict()`` returns
predicted *angles* for benchmarking, and builds its template from ``truth.csv``. The
video tool needs the learner's *position in the demo* instead, so these wrappers call
the same matching code against the demo's own MediaPipe reference (on the demo's time
base) and keep the matched demo time. No ground truth is used, except by ``truth``.

    truth       truth.csv of the dummy data (perfect; checks the rest of the pipeline)
    dtw         offline DTW: the optimal warping path (uses the whole recording)
    dtw-online  streaming DTW with a short lookahead (``lag`` samples)
    gvf         GVF particle filter, the deployed live tracker (streaming)
    hmm         Hidden Markov Model over positions in the demo (streaming forward filter)

The repository's HiddenMarkov decodes the learner's *angle* (its hidden states are angle
values), so it cannot say where in the demo the learner is. ``hmm`` applies the same method
(Gaussian angle emissions, forward recursion, its ``sigma``) with positions in the demo as the
hidden states: each step the learner stays or moves forward up to ``max_step`` frames.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .session import BridgeError, Session

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ALGORITHMS_DIR = ROOT / "vendor" / "Video-Sticky-Algorithms"
REPO_URL = "https://github.com/kaithesavior/Video-Sticky-Algorithms.git"

TRACKERS = ("gvf", "hmm", "dtw-online", "dtw", "truth")
# Streaming trackers use only past samples (plus `lag` for dtw-online), so they can run live.
STREAMING = {"gvf", "hmm", "dtw-online"}

DTW_DEFAULTS = {"rate_hz": 20.0, "band_frac": 1.0, "smooth_window": 3, "lag": 4}
# sigma: angle tolerance in degrees (the sticky and MediaPipe differ by about 30° even in step).
# stay: chance of not moving on in one step; max_step: most frames moved on in one step
# (4 frames per 1/20 s allows up to 4x the demo's pace).
HMM_DEFAULTS = {"rate_hz": 20.0, "sigma": 30.0, "stay": 0.25, "max_step": 4}


@dataclass
class Track:
    tracker: str
    t: np.ndarray  # learner seconds
    demo_s: np.ndarray  # learner's position in the demo video, seconds
    angle: np.ndarray  # learner's sticky angle at t, degrees
    streaming: bool
    latency_s: float = 0.0  # lookahead a streaming tracker needs before it can report t


def algorithms_dir(explicit: str | Path | None = None) -> Path:
    path = Path(explicit or os.environ.get("STICKIES_ALGORITHMS") or DEFAULT_ALGORITHMS_DIR).expanduser()
    if not (path / "tests" / "algorithms" / "dtw.py").exists():
        raise BridgeError(
            f"Video-Sticky-Algorithms not found at {path}.\n"
            f"Run `npm run setup:stickies` (clones {REPO_URL} into vendor/),\n"
            "or pass --algorithms DIR / set STICKIES_ALGORITHMS."
        )
    return path.resolve()


def _import_algorithms(path: Path):
    """Imports the algorithms package (`tests.algorithms`) of Video-Sticky-Algorithms."""
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
    loaded = sys.modules.get("tests")
    if loaded is not None and not str(getattr(loaded, "__file__", "") or "").startswith(str(path)):
        raise BridgeError("Another `tests` package is already imported; cannot load Video-Sticky-Algorithms.")
    from tests.algorithms import dtw, gvf  # noqa: PLC0415 - path set up above
    from tests.algorithms.builtin import GVFKalman  # noqa: PLC0415

    return dtw, gvf, GVFKalman


def _grid(session: Session, rate_hz: float):
    step = 1.0 / rate_hz
    t = np.arange(session.learner_t[0], session.learner_t[-1] + 1e-9, step)
    angle = np.interp(t, session.learner_t, session.learner_angle)
    return t, angle


def _truth(session: Session, _params: dict) -> Track:
    if session.truth is None:
        raise BridgeError("The truth tracker needs truth.csv (dummy data only). Choose gvf, dtw-online or dtw.")
    t, angle = _grid(session, 20.0)
    demo = np.interp(t, session.truth["t_s"], session.truth["demo_s"])  # holds the ends (pre-roll)
    return Track("truth", t, demo, angle, streaming=False)


def _dtw(session: Session, params: dict, online: bool, algorithms: Path) -> Track:
    dtw, _gvf, _ = _import_algorithms(algorithms)
    p = {**DTW_DEFAULTS, **params}
    rate = float(p["rate_hz"])
    t, query = _grid(session, rate)
    ref_t = np.arange(0.0, session.demo_duration + 1e-9, 1.0 / rate)
    template = session.reference_at(ref_t)
    if online:
        idx = dtw._lagged_indices(query, template, float(p["band_frac"]), int(p["smooth_window"]), int(p["lag"]))
    else:
        idx = dtw._offline_indices(query, template, float(p["band_frac"]), int(p["smooth_window"]))
    name = "dtw-online" if online else "dtw"
    latency = int(p["lag"]) / rate if online else 0.0
    return Track(name, t, ref_t[idx], query, streaming=online, latency_s=latency)


def _gvf(session: Session, params: dict, algorithms: Path) -> Track:
    _dtw_mod, gvf, GVFKalman = _import_algorithms(algorithms)
    f = {**GVFKalman().hyperparameters, **params}
    tracker = gvf.GvfTracker(session.reference_t, session.reference_angle.reshape(-1, 1), f)
    tracker.free = True  # deployed mode: the video follows the learner
    step = float(f["gvf_step_s"])
    lags = np.linspace(0.0, float(f["match_window_s"]), max(1, int(f["match_points"])))
    t0, t1 = session.learner_t[0], session.learner_t[-1]
    steps = int((t1 - t0) / step)
    times = np.empty(steps)
    spots = np.empty(steps)
    for k in range(1, steps + 1):
        now = t0 + k * step
        # The last match_window_s of sticky angles, as the live tracker sees them.
        observed = np.interp(now - lags, session.learner_t, session.learner_angle).reshape(-1, 1)
        tracker.update(([k], [observed]), tracker.pos)  # video_t: the video is where the learner is
        times[k - 1] = now
        spots[k - 1] = tracker.pos
    t, angle = _grid(session, 20.0)
    return Track("gvf", t, np.interp(t, times, spots), angle, streaming=True)


def _hmm(session: Session, params: dict) -> Track:
    """Left-to-right HMM over demo positions, filtered forward one learner sample at a time."""
    p = {**HMM_DEFAULTS, **params}
    rate, sigma = float(p["rate_hz"]), float(p["sigma"])
    max_step = max(1, int(p["max_step"]))
    stay = min(0.95, max(0.0, float(p["stay"])))
    if sigma <= 0 or rate <= 0:
        raise BridgeError("hmm: sigma and rate_hz must be above 0.")
    # P(move on d frames): `stay` for d = 0, the rest shared out, most for small steps.
    ahead = np.arange(max_step, 0, -1, dtype=float)
    steps = np.concatenate([[stay], (1 - stay) * ahead / ahead.sum()])
    t, query = _grid(session, rate)
    ref_t = np.arange(0.0, session.demo_duration + 1e-9, 1.0 / rate)
    template = session.reference_at(ref_t)
    belief = np.zeros(len(ref_t))
    belief[0] = 1.0  # the learner starts at the start of the demo
    demo = np.empty(len(t))
    for i, observed in enumerate(query):
        if i:
            moved = steps[0] * belief
            for d in range(1, len(steps)):
                moved[d:] += steps[d] * belief[:-d]
                moved[-1] += steps[d] * belief[-d:].sum()  # the end of the demo holds
            belief = moved
        belief = belief * np.exp(-0.5 * ((observed - template) / sigma) ** 2) + 1e-300
        belief /= belief.sum()
        demo[i] = ref_t[int(np.argmax(belief))]
    return Track("hmm", t, demo, query, streaming=True)


def run_tracker(name: str, session: Session, params: dict | None = None, algorithms: str | Path | None = None) -> Track:
    params = params or {}
    if name == "truth":
        return _truth(session, params)
    if name not in TRACKERS:
        raise BridgeError(f"Unknown tracker {name!r}. Choose from: {', '.join(TRACKERS)}.")
    if name == "hmm":
        return _hmm(session, _checked_params(name, params, HMM_DEFAULTS))
    path = algorithms_dir(algorithms)
    if name == "gvf":
        _dtw_mod, _gvf_mod, GVFKalman = _import_algorithms(path)
        return _gvf(session, _checked_params(name, params, GVFKalman().hyperparameters), path)
    return _dtw(session, _checked_params(name, params, DTW_DEFAULTS), online=name == "dtw-online", algorithms=path)


def _checked_params(tracker: str, params: dict, defaults: dict) -> dict:
    """Overrides with known names only, converted to the type of each default."""
    unknown = sorted(set(params) - set(defaults))
    if unknown:
        raise BridgeError(
            f"Unknown {tracker} hyperparameter(s): {', '.join(unknown)}. Known: {', '.join(sorted(defaults))}."
        )
    out = {}
    for key, value in params.items():
        kind = type(defaults[key])
        try:
            if kind is bool:
                if not isinstance(value, bool):
                    raise ValueError
                out[key] = value
            else:
                out[key] = kind(value)
        except (TypeError, ValueError):
            expected = {"int": "an integer", "float": "a number", "bool": "true or false", "str": "text"}
            raise BridgeError(f"--param {key}={value!r}: expected {expected.get(kind.__name__, kind.__name__)}.") from None
    return out


def tracking_error(track: Track, session: Session) -> dict | None:
    """Position error against truth.csv (dummy data), over the part the truth covers."""
    if session.truth is None:
        return None
    truth_t = session.truth["t_s"].to_numpy(float)
    inside = (track.t >= truth_t[0]) & (track.t <= truth_t[-1])
    if not inside.any():
        return None
    error = np.abs(track.demo_s[inside] - np.interp(track.t[inside], truth_t, session.truth["demo_s"]))
    return {
        "mae_s": round(float(error.mean()), 3),
        "p90_s": round(float(np.percentile(error, 90)), 3),
        "max_s": round(float(error.max()), 3),
    }
