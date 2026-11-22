"""Where the moving body part is in the demo video, for the focus (and zoom) parameters.

``extract_pose`` runs the MediaPipe pose landmarker on the demo video (the model file
ships with Video-Sticky-Algorithms) and writes landmark positions as percent of the
frame, the units of the tool's x / y focus. ``load_focus`` turns such a file into one
focus point per video frame.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .session import BridgeError

# MediaPipe pose landmark indices.
LANDMARKS = {"left": {"shoulder": 11, "elbow": 13, "wrist": 15}, "right": {"shoulder": 12, "elbow": 14, "wrist": 16}}
# Focus point: the mean of these joints.
FOCUS_PARTS = {
    "forearm": ("elbow", "wrist"),
    "upper-arm": ("shoulder", "elbow"),
    "arm": ("shoulder", "elbow", "wrist"),
    "elbow": ("elbow",),
    "wrist": ("wrist",),
}
MIN_VISIBILITY = 0.5
MODEL_PATH = Path("Mediapipe") / "pose_landmarker_full.task"


def extract_pose(video: Path, out_csv: Path, algorithms: Path, side: str = "right", progress=print) -> Path:
    try:
        import cv2  # noqa: PLC0415 - optional dependency
        import mediapipe as mp  # noqa: PLC0415
        from mediapipe.tasks.python import BaseOptions, vision  # noqa: PLC0415
    except ImportError as exc:
        raise BridgeError(
            "Pose extraction needs mediapipe and opencv-python "
            "(pip install -r stickies_bridge/requirements.txt), or pass --pose none."
        ) from exc
    model = algorithms / MODEL_PATH
    if not model.exists():
        raise BridgeError(f"MediaPipe model not found: {model}")
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise BridgeError(f"Cannot open video {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    joints = LANDMARKS[side]
    rows = []
    options = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model)), running_mode=vision.RunningMode.VIDEO
    )
    with vision.PoseLandmarker.create_from_options(options) as landmarker:
        frame = 0
        while True:
            ok, image = cap.read()
            if not ok:
                break
            ms = int(round(frame * 1000 / fps))
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(image, cv2.COLOR_BGR2RGB)), ms
            )
            row = {"time_s": round(frame / fps, 4), "detected": int(bool(result.pose_landmarks))}
            for joint, index in joints.items():
                if result.pose_landmarks:
                    lm = result.pose_landmarks[0][index]
                    row.update({f"{joint}_x": lm.x * 100, f"{joint}_y": lm.y * 100, f"{joint}_vis": lm.visibility})
                else:
                    row.update({f"{joint}_x": np.nan, f"{joint}_y": np.nan, f"{joint}_vis": 0.0})
            rows.append(row)
            frame += 1
            if total and frame % 150 == 0:
                progress(f"  pose: {frame}/{total} frames")
    cap.release()
    if not rows:
        raise BridgeError(f"No frames could be read from {video}")
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(out_csv, index=False, float_format="%.3f")
    return out_csv


def load_focus(pose_csv: Path, part: str = "forearm") -> pd.DataFrame:
    """time_s, x, y (percent of the frame); gaps filled, jitter removed."""
    if part not in FOCUS_PARTS:
        raise BridgeError(f"Unknown focus part {part!r}. Choose from: {', '.join(FOCUS_PARTS)}.")
    pose = pd.read_csv(pose_csv)
    joints = FOCUS_PARTS[part]
    needed = ["time_s"] + [f"{j}_{a}" for j in joints for a in ("x", "y", "vis")]
    missing = [c for c in needed if c not in pose.columns]
    if missing:
        raise BridgeError(f"{pose_csv} is missing columns {missing} (make it with `python3 -m stickies_bridge pose`).")
    xs, ys = [], []
    for joint in joints:
        seen = pose[f"{joint}_vis"] >= MIN_VISIBILITY
        xs.append(pose[f"{joint}_x"].where(seen))
        ys.append(pose[f"{joint}_y"].where(seen))
    focus = pd.DataFrame({"time_s": pose["time_s"], "x": pd.concat(xs, axis=1).mean(axis=1), "y": pd.concat(ys, axis=1).mean(axis=1)})
    if focus[["x", "y"]].notna().sum().min() == 0:
        raise BridgeError(f"The {part} is never visible in {pose_csv}.")
    for axis in ("x", "y"):
        filled = focus[axis].interpolate(limit_direction="both")
        # A centred median over ~0.3 s removes landmark jitter without lagging the move.
        focus[axis] = filled.rolling(9, center=True, min_periods=1).median().clip(0, 100)
    return focus
