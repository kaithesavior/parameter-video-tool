"""MediaPipe Pose: shoulder and elbow positions per frame, in pixels.

Missing or low-confidence detections are filled by interpolation, then a short
moving average removes frame-to-frame jitter.
"""

from __future__ import annotations

import urllib.request
from pathlib import Path

import cv2
import numpy as np

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_full/float16/latest/pose_landmarker_full.task"
)
MIN_VISIBILITY = 0.3
SMOOTH_FRAMES = 3


def ensure_model(path: Path) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading MediaPipe pose model to {path} …")
        urllib.request.urlretrieve(MODEL_URL, path)
    return path


def _detect(frames_dir: Path, info: dict, model: Path, indices: list[int]) -> np.ndarray:
    """Raw landmarks [frame, landmark, (x, y)] in pixels; NaN where not found."""
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    options = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model)),
        running_mode=vision.RunningMode.VIDEO,
    )
    points = np.full((info["frameCount"], len(indices), 2), np.nan)
    with vision.PoseLandmarker.create_from_options(options) as landmarker:
        for frame in range(info["frameCount"]):
            rgb = cv2.cvtColor(cv2.imread(str(frames_dir / f"{frame:05d}.jpg")), cv2.COLOR_BGR2RGB)
            timestamp = int(frame * 1000 / info["fps"])
            result = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp)
            if not result.pose_landmarks:
                continue
            landmarks = result.pose_landmarks[0]
            for slot, index in enumerate(indices):
                mark = landmarks[index]
                if mark.visibility >= MIN_VISIBILITY:
                    points[frame, slot] = (mark.x * info["width"], mark.y * info["height"])
    return points


def _fill_and_smooth(points: np.ndarray) -> np.ndarray:
    frames = np.arange(points.shape[0])
    out = points.copy()
    for slot in range(points.shape[1]):
        for axis in range(2):
            series = out[:, slot, axis]
            known = ~np.isnan(series)
            if not known.any():
                raise SystemExit("Pose landmark never detected; check the pose indices in prompts.json.")
            series[:] = np.interp(frames, frames[known], series[known])
            kernel = np.ones(SMOOTH_FRAMES) / SMOOTH_FRAMES
            padded = np.pad(series, SMOOTH_FRAMES // 2, mode="edge")
            series[:] = np.convolve(padded, kernel, mode="valid")
    return out


def track_joints(frames_dir: Path, info: dict, prompts: dict, model: Path) -> list[dict[str, np.ndarray]]:
    """Per region: {"shoulder": [frame, 2], "elbow": [frame, 2]} in pixels."""
    indices = []
    for region in prompts["regions"]:
        indices += [region["pose"]["shoulder"], region["pose"]["elbow"]]
    print("Finding shoulders and elbows with MediaPipe Pose …")
    points = _fill_and_smooth(_detect(frames_dir, info, ensure_model(model), indices))
    return [{"shoulder": points[:, 2 * i], "elbow": points[:, 2 * i + 1]} for i in range(len(prompts["regions"]))]
