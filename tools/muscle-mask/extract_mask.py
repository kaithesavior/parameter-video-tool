"""Generate biceps outlines for a video. Run once, offline; the browser only reads the JSON.

Pipeline:
  1. arm_tracking.py  SAM 2 tracks each whole arm (pixel-exact edges)
  2. pose.py          MediaPipe Pose finds shoulder and elbow per frame
  3. biceps.py        arm mask ∩ upper-arm ellipse → biceps outline
  4. output.py        JSON for the browser + optional preview sheet

    python tools/muscle-mask/extract_mask.py --preview mask-preview.jpg

Click prompts and pose indices live in prompts.json. Pass --cache to reuse
SAM 2 results while tuning biceps.py (tracking takes several minutes).
"""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

import cv2

from arm_tracking import track_arms
from biceps import build_outlines
from output import build_document, write_document, write_preview
from pose import track_joints

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = Path.home() / ".cache" / "stickies-muscle-mask"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prompts", type=Path, default=Path(__file__).with_name("prompts.json"))
    parser.add_argument("--out", type=Path, default=PROJECT_ROOT / "assets" / "biceps-mask.json")
    parser.add_argument("--models", type=Path, default=MODEL_DIR, help="Where model files are downloaded.")
    parser.add_argument("--cache", type=Path, help="Cache file for SAM 2 arm masks (.npz).")
    parser.add_argument("--preview", type=Path, help="Contact sheet of overlays for checking the result.")
    return parser.parse_args()


def extract_frames(video: Path, folder: Path) -> dict:
    """Both SAM 2 and the pose stage read numbered JPEG frames: 00000.jpg, 00001.jpg, …"""
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise SystemExit(f"Cannot open video: {video}")
    fps, count = capture.get(cv2.CAP_PROP_FPS), 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        cv2.imwrite(str(folder / f"{count:05d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        count += 1
    capture.release()
    height, width = cv2.imread(str(folder / "00000.jpg")).shape[:2]
    return {"fps": fps, "frameCount": count, "width": width, "height": height}


def main() -> None:
    args = parse_args()
    prompts = json.loads(args.prompts.read_text())
    with tempfile.TemporaryDirectory() as tmp:
        frames_dir = Path(tmp)
        info = extract_frames(PROJECT_ROOT / prompts["video"], frames_dir)
        print(f"{info['frameCount']} frames at {info['fps']:.3f} fps, {info['width']}×{info['height']}")
        arms = track_arms(frames_dir, prompts, args.models / "sam2.1_hiera_small.pt", info, args.cache)
        joints = track_joints(frames_dir, info, prompts, args.models / "pose_landmarker_full.task")
        document = build_document(info, prompts, build_outlines(arms, joints))
        write_document(document, args.out)
        if args.preview:
            write_preview(frames_dir, document, joints, args.preview)


if __name__ == "__main__":
    main()
