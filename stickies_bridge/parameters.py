"""From a track (learner -> demo position) to the video tool's parameters.

    speed  the learner's pace: demo seconds per learner second, so the video plays as
           fast as the learner moves (0.25-3x, the tool's range)
    x, y   the moving body part in the demo frame at the learner's position (MediaPipe)
    zoom   a steady close-up on that part; optionally closer while the learner's angle
           is far from the demo's (form check, off unless --error-zoom is given)

Offline, windows are centred. Live (``causal=True``) they only look back, as a live
sender can only know the past.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .session import Session
from .trackers import Track

LIMITS = {"speed": (0.25, 3.0), "zoom": (1.0, 5.0), "x": (0.0, 100.0), "y": (0.0, 100.0)}


@dataclass
class Mapping:
    pace_window_s: float = 2.0  # how much movement one speed value summarises
    zoom: float | None = None  # steady zoom; None -> 1.6 with a focus source, else 1
    error_zoom_deg: float | None = None  # zoom to zoom_max while the angle error is above this
    zoom_max: float = 2.5
    error_window_s: float = 0.5


def _windows(t: np.ndarray, width: float, causal: bool):
    lo = np.searchsorted(t, t - (width if causal else width / 2), side="left")
    hi = np.searchsorted(t, t if causal else t + width / 2, side="right")
    return lo, hi


def pace(t: np.ndarray, demo_s: np.ndarray, width: float, causal: bool) -> np.ndarray:
    """Least-squares slope of demo position over learner time in a sliding window."""
    lo, hi = _windows(t, width, causal)
    out = np.empty(len(t))
    for i, (a, b) in enumerate(zip(lo, hi)):
        tt, dd = t[a:b], demo_s[a:b]
        if len(tt) < 3 or np.ptp(tt) <= 0:
            out[i] = out[i - 1] if i else 1.0
            continue
        tc = tt - tt.mean()
        out[i] = float(np.dot(tc, dd - dd.mean()) / np.dot(tc, tc))
    return np.clip(out, *LIMITS["speed"])


def window_mean(t: np.ndarray, values: np.ndarray, width: float, causal: bool) -> np.ndarray:
    lo, hi = _windows(t, width, causal)
    csum = np.concatenate([[0.0], np.cumsum(values)])
    return (csum[hi] - csum[lo]) / np.maximum(1, hi - lo)


def parameter_samples(
    track: Track, session: Session, focus: pd.DataFrame | None, mapping: Mapping, causal: bool = False
) -> pd.DataFrame:
    """One row per learner sample: t, demo_s, speed, zoom, x, y, error_deg."""
    t, demo = track.t, np.clip(track.demo_s, 0.0, session.demo_duration)
    speed = pace(t, demo, mapping.pace_window_s, causal)
    error = window_mean(t, np.abs(track.angle - session.reference_at(demo)), mapping.error_window_s, causal)
    if focus is not None:
        x = np.interp(demo, focus["time_s"], focus["x"])
        y = np.interp(demo, focus["time_s"], focus["y"])
    else:
        x = np.full(len(t), 50.0)
        y = np.full(len(t), 50.0)
    base = mapping.zoom if mapping.zoom is not None else (1.6 if focus is not None else 1.0)
    zoom = np.full(len(t), base)
    if mapping.error_zoom_deg is not None:
        zoom = np.where(error > mapping.error_zoom_deg, max(base, mapping.zoom_max), zoom)
    return pd.DataFrame(
        {
            "t": t,
            "demo_s": demo,
            "speed": speed,
            "zoom": np.clip(zoom, *LIMITS["zoom"]),
            "x": np.clip(x, *LIMITS["x"]),
            "y": np.clip(y, *LIMITS["y"]),
            "error_deg": error,
        }
    )
