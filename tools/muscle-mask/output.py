"""Writes the outline document the browser loads, plus an optional preview image."""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

GENERATOR = "tools/muscle-mask · SAM 2.1 hiera-small arm tracking + MediaPipe Pose"


def build_document(info: dict, prompts: dict, outlines: list) -> dict:
    return {
        "version": 1,
        "source": prompts["video"],
        "muscle": prompts["muscle"],
        "generator": GENERATOR,
        "fps": round(info["fps"], 6),
        "frameCount": info["frameCount"],
        "width": info["width"],
        "height": info["height"],
        "regions": [{"id": r["id"], "label": r["label"]} for r in prompts["regions"]],
        "frames": outlines,
    }


def write_document(document: dict, path: Path) -> None:
    path.write_text(json.dumps(document, separators=(",", ":")))
    empty = sum(outline is None for frame in document["frames"] for outline in frame)
    print(f"Wrote {path} ({path.stat().st_size // 1024} KB, {empty} empty outlines)")


def write_preview(frames_dir: Path, document: dict, joints: list, path: Path, samples: int = 12) -> None:
    width, height = document["width"], document["height"]
    tiles = []
    for index in np.linspace(0, document["frameCount"] - 1, samples).astype(int):
        image = cv2.imread(str(frames_dir / f"{index:05d}.jpg"))
        overlay = image.copy()
        for outline in document["frames"][index]:
            if outline:
                points = (np.array(outline).reshape(-1, 2) * [width, height]).astype(np.int32)
                cv2.fillPoly(overlay, [points], (40, 80, 255))
        image = cv2.addWeighted(overlay, 0.5, image, 0.5, 0)
        for joint in joints:
            for name in ("shoulder", "elbow"):
                x, y = joint[name][index]
                cv2.circle(image, (int(x), int(y)), 7, (0, 255, 255), -1)
        cv2.putText(image, f"#{index}", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 255, 255), 4)
        tiles.append(cv2.resize(image[:, width // 3 : width * 7 // 8], (420, 380)))
    rows = [np.hstack(tiles[i : i + 4]) for i in range(0, len(tiles), 4)]
    cv2.imwrite(str(path), np.vstack(rows))
    print(f"Preview: {path}")
