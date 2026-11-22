"""Parameter samples (learner clock) -> a cue timeline file (video clock) for the tool.

The file is the tool's ``stickies-preset`` v1 format (see README, "Cue timeline file"):
cues at seconds into the demo video, first cue at 0, at most 100 cues, labels of 1-80
characters. The demo is cut into bins of ``step`` seconds; each bin gets the parameters
the learner had while they were in it. Bins whose values hardly change are merged.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

MAX_CUES = 100
# Differences smaller than these do not start a new cue.
TOLERANCE = {"speed": 0.05, "zoom": 0.05, "x": 2.0, "y": 2.0}


def _bins(samples: pd.DataFrame, focus: pd.DataFrame | None, duration: float, step: float) -> list[dict]:
    # Forward-only position: a tracker wobbling back must not revisit earlier bins.
    demo = np.maximum.accumulate(samples["demo_s"].to_numpy(float))
    starts = np.arange(0.0, duration, step)
    bins: list[dict | None] = []
    for start in starts:
        inside = (demo >= start) & (demo < start + step)
        if not inside.any():
            bins.append(None)
            continue
        rows = samples[inside]
        values = {
            "speed": float(rows["speed"].median()),
            "zoom": float(rows["zoom"].max()),
            "x": float(rows["x"].median()),
            "y": float(rows["y"].median()),
            "error_deg": float(rows["error_deg"].mean()),
        }
        if focus is not None:  # the body part where the video is, not where the learner's samples fell
            in_focus = (focus["time_s"] >= start) & (focus["time_s"] < start + step)
            if in_focus.any():
                values["x"] = float(focus.loc[in_focus, "x"].median())
                values["y"] = float(focus.loc[in_focus, "y"].median())
        bins.append(values)
    known = [b for b in bins if b is not None]
    if not known:
        raise ValueError("The track never enters the demo video.")
    filled, previous = [], known[0]  # before the learner's first bin: their first values
    for start, values in zip(starts, bins):
        previous = values or previous
        filled.append({"time": float(start), **previous})
    return filled


def _merge(bins: list[dict]) -> list[dict]:
    cues = [bins[0]]
    for current in bins[1:]:
        if any(abs(current[k] - cues[-1][k]) >= tol for k, tol in TOLERANCE.items()):
            cues.append(current)
    return cues


def _label(cue: dict, error_zoom: float | None) -> str:
    label = f"Learner pace {cue['speed']:.2f}x"
    if error_zoom is not None and cue["error_deg"] > error_zoom:
        label += f" · form check ({cue['error_deg']:.0f}° off)"
    return label


def build_timeline(
    samples: pd.DataFrame,
    duration: float,
    video_name: str | None,
    name: str,
    step: float = 0.5,
    focus: pd.DataFrame | None = None,
    error_zoom: float | None = None,
) -> dict:
    step = max(0.05, float(step))
    while True:
        cues = _merge(_bins(samples, focus, duration, step))
        if len(cues) <= MAX_CUES:
            break
        step *= 1.25
    out = []
    for cue in cues:
        out.append(
            {
                "time": round(cue["time"], 3),
                "label": _label(cue, error_zoom)[:80],
                "parameters": {
                    "speed": round(cue["speed"], 2),
                    "zoom": round(cue["zoom"], 2),
                    "x": round(cue["x"], 1),
                    "y": round(cue["y"], 1),
                },
            }
        )
    data = {"kind": "stickies-preset", "version": 1}
    if video_name:
        data["video"] = video_name
    data["preset"] = {"name": name.strip()[:80] or "Stickies", "cues": out}
    return data
