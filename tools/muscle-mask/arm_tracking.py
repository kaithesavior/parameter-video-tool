"""SAM 2 arm tracking: one whole-arm mask per region per frame.

SAM 2 follows a whole arm reliably but cannot tell where the biceps ends, so this
stage tracks the arm and biceps.py trims it to the upper arm using pose joints.
Results are cached because tracking takes minutes and the later stages are tuned often.
"""

from __future__ import annotations

import os
import urllib.request
from pathlib import Path

import numpy as np

CHECKPOINT_URL = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt"
MODEL_CONFIG = "configs/sam2.1/sam2.1_hiera_s.yaml"


def ensure_checkpoint(path: Path) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading SAM 2.1 checkpoint to {path} …")
        urllib.request.urlretrieve(CHECKPOINT_URL, path)
    return path


def _device():
    import torch

    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        return torch.device("mps")
    return torch.device("cpu")


def _add_prompts(predictor, state, prompts: dict) -> None:
    for obj_id, region in enumerate(prompts["regions"], start=1):
        points = np.array(region["positive"] + region["negative"], dtype=np.float32)
        labels = np.array([1] * len(region["positive"]) + [0] * len(region["negative"]), dtype=np.int32)
        predictor.add_new_points_or_box(
            inference_state=state,
            frame_idx=prompts["promptFrame"],
            obj_id=obj_id,
            points=points,
            labels=labels,
            box=np.array(region["armBox"], dtype=np.float32),
        )


def _run_sam(frames_dir: Path, prompts: dict, checkpoint: Path, frame_count: int, shape: tuple) -> np.ndarray:
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    device = _device()
    print(f"Tracking arms with SAM 2 on {device} (takes a few minutes) …")
    predictor = build_sam2_video_predictor(MODEL_CONFIG, str(checkpoint), device=device)
    masks = np.zeros((frame_count, len(prompts["regions"]), *shape), dtype=bool)
    with torch.inference_mode():
        state = predictor.init_state(video_path=str(frames_dir), offload_video_to_cpu=True)
        _add_prompts(predictor, state, prompts)
        for frame_idx, obj_ids, logits in predictor.propagate_in_video(state):
            for i, obj_id in enumerate(obj_ids):
                masks[frame_idx, obj_id - 1] = (logits[i, 0] > 0).cpu().numpy()
    return masks


def track_arms(frames_dir: Path, prompts: dict, checkpoint: Path, info: dict, cache: Path | None) -> np.ndarray:
    """Boolean array [frame, region, height, width]."""
    shape = (info["height"], info["width"])
    if cache and cache.exists():
        print(f"Using cached arm masks: {cache}")
        packed = np.load(cache)["packed"]
        return np.unpackbits(packed, axis=-1, count=shape[1]).astype(bool)
    masks = _run_sam(frames_dir, prompts, ensure_checkpoint(checkpoint), info["frameCount"], shape)
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cache, packed=np.packbits(masks, axis=-1))
    return masks
