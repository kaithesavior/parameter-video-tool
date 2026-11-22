"""Loading a learner's sticky session and the demo video's MediaPipe reference.

Folder layouts understood (those of Video-Sticky-Algorithms):

    <exercise>/reference.csv          demo angles from MediaPipe: time_s, <segment>...
    <exercise>/reference.json         {"video": "curls.mp4", ...}
    <exercise>/curls.mp4              the demo video
    <exercise>/x1.50/stickies.csv     a learner: sensor_name, t_s, tilt_deg, ...
    <exercise>/x1.50/imu.json         {"stickies": {sensor: {"demo_column": ...}}}
    <exercise>/x1.50/truth.csv        dummy data only: t_s, demo_s (where the learner really was)

A recorded take (``take/``, with ``session.json``) works the same way. Any file can be
given explicitly instead.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

DEFAULT_SEGMENT = "right_forearm_elev_deg"
CALIBRATION_FILES = ("imu.json", "session.json", "take.json")


class BridgeError(Exception):
    """A problem with the input that the user can fix; printed without a traceback."""


@dataclass
class Session:
    name: str
    segment: str
    learner_t: np.ndarray  # learner seconds
    learner_angle: np.ndarray  # sticky angle of the segment, degrees
    reference_t: np.ndarray  # demo seconds
    reference_angle: np.ndarray  # MediaPipe angle of the segment, degrees
    video: Path | None  # the demo video, if found
    truth: pd.DataFrame | None  # t_s, demo_s (dummy data only)

    @property
    def demo_duration(self) -> float:
        return float(self.reference_t[-1])

    def reference_at(self, demo_s) -> np.ndarray:
        return np.interp(np.asarray(demo_s, float), self.reference_t, self.reference_angle)


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise BridgeError(f"Cannot read {path}: {exc}") from exc


def _calibration(folder: Path) -> dict:
    """sensor name -> {"demo_column": segment, ...}, from the first calibration file found."""
    for name in CALIBRATION_FILES:
        path = folder / name
        if not path.exists():
            continue
        data = _read_json(path)
        stickies = data.get("stickies") or (data.get("calibration") or {}).get("stickies")
        if isinstance(stickies, dict) and stickies:
            return stickies
    return {}


def _find_upwards(folder: Path, name: str, levels: int = 2) -> Path | None:
    for candidate in [folder, *list(folder.parents)[:levels]]:
        if (candidate / name).exists():
            return candidate / name
    return None


def load_session(
    folder: str | Path,
    reference: str | Path | None = None,
    video: str | Path | None = None,
    segment: str | None = None,
) -> Session:
    folder = Path(folder).expanduser().resolve()
    stickies_path = folder / "stickies.csv" if folder.is_dir() else folder
    if not stickies_path.exists():
        raise BridgeError(f"No stickies.csv in {folder}.")
    folder = stickies_path.parent

    reference_path = Path(reference).expanduser().resolve() if reference else _find_upwards(folder, "reference.csv")
    if not reference_path or not reference_path.exists():
        raise BridgeError(f"No reference.csv found for {folder}; pass --reference (the demo's MediaPipe angles).")
    ref = pd.read_csv(reference_path)
    if "time_s" not in ref.columns:
        raise BridgeError(f"{reference_path} has no time_s column.")

    stickies = pd.read_csv(stickies_path)
    for column in ("sensor_name", "t_s", "tilt_deg"):
        if column not in stickies.columns:
            raise BridgeError(f"{stickies_path} has no {column} column.")

    calibration = _calibration(folder)
    by_segment = {
        info.get("demo_column"): sensor for sensor, info in calibration.items() if isinstance(info, dict)
    }
    segments = [s for s in by_segment if s in ref.columns]
    if segment is None:
        segment = DEFAULT_SEGMENT if DEFAULT_SEGMENT in segments else (segments[0] if segments else None)
    if segment not in by_segment:
        known = ", ".join(segments) or "none (no calibration file with stickies -> demo_column)"
        raise BridgeError(f"No sticky is calibrated to segment {segment!r}. Calibrated: {known}.")
    if segment not in ref.columns:
        raise BridgeError(f"{reference_path} has no {segment} column.")

    rows = stickies[stickies["sensor_name"] == by_segment[segment]].sort_values("t_s")
    rows = rows[np.isfinite(rows["tilt_deg"]) & np.isfinite(rows["t_s"])]
    if len(rows) < 10:
        raise BridgeError(f"Sticky {by_segment[segment]} has only {len(rows)} samples.")
    ref = ref[np.isfinite(ref["time_s"])].sort_values("time_s")
    ref_angle = ref[segment].interpolate(limit_direction="both").to_numpy(float)

    truth = None
    if (folder / "truth.csv").exists():
        truth = pd.read_csv(folder / "truth.csv")
        if not {"t_s", "demo_s"} <= set(truth.columns):
            truth = None

    video_path = None
    if video:
        video_path = Path(video).expanduser().resolve()
        if not video_path.exists():
            raise BridgeError(f"Video not found: {video_path}")
    else:
        meta = reference_path.with_suffix(".json")
        name = _read_json(meta).get("video") if meta.exists() else None
        if name and (reference_path.parent / name).exists():
            video_path = reference_path.parent / name

    name = folder.name if folder.name not in ("take", "") else folder.parent.name + "-take"
    if folder.parent == reference_path.parent and folder.name != "take":
        name = f"{reference_path.parent.name}-{folder.name}"
    return Session(
        name=name,
        segment=segment,
        learner_t=rows["t_s"].to_numpy(float),
        learner_angle=rows["tilt_deg"].to_numpy(float),
        reference_t=ref["time_s"].to_numpy(float),
        reference_angle=ref_angle,
        video=video_path,
        truth=truth,
    )
