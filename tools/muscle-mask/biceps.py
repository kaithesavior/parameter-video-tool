"""Biceps region = SAM 2 arm mask ∩ an ellipse along the shoulder→elbow segment.

The ellipse sets the anatomical limits (below the deltoid, above the elbow crease);
the SAM 2 mask supplies the exact left and right edges of the arm.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

# Positions along the upper arm, as fractions of shoulder→elbow length.
BELLY_CENTER = 0.58  # biceps belly sits a little below the middle of the upper arm
HALF_LENGTH = 0.38  # ellipse covers roughly 0.20 → 0.96 of the upper arm
HALF_WIDTH = 0.34  # generous; the arm mask trims the sides

MORPH_KERNEL_PX = 5
MIN_AREA_PX = 80
SIMPLIFY_RATIO = 0.006  # outline tolerance as a fraction of its perimeter
COORD_DECIMALS = 4


def upper_arm_ellipse(shape: tuple, shoulder: np.ndarray, elbow: np.ndarray) -> np.ndarray:
    axis = elbow - shoulder
    length = float(np.hypot(*axis))
    mask = np.zeros(shape, np.uint8)
    if length < 1:
        return mask.astype(bool)
    center = shoulder + axis * BELLY_CENTER
    angle = math.degrees(math.atan2(axis[1], axis[0]))
    axes = (int(length * HALF_LENGTH), int(length * HALF_WIDTH))
    cv2.ellipse(mask, (int(center[0]), int(center[1])), axes, angle, 0, 360, 1, thickness=-1)
    return mask.astype(bool)


def biceps_mask(arm: np.ndarray, shoulder: np.ndarray, elbow: np.ndarray) -> np.ndarray:
    region = (arm & upper_arm_ellipse(arm.shape, shoulder, elbow)).astype(np.uint8)
    kernel = np.ones((MORPH_KERNEL_PX, MORPH_KERNEL_PX), np.uint8)
    region = cv2.morphologyEx(region, cv2.MORPH_OPEN, kernel)
    return cv2.morphologyEx(region, cv2.MORPH_CLOSE, kernel)


def outline(mask: np.ndarray) -> list[float] | None:
    """Largest outer contour, simplified and normalized to 0–1, as a flat [x0, y0, x1, y1, …] list."""
    height, width = mask.shape
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < MIN_AREA_PX:
        return None
    simplified = cv2.approxPolyDP(contour, SIMPLIFY_RATIO * cv2.arcLength(contour, True), True)
    flat: list[float] = []
    for x, y in simplified.reshape(-1, 2):
        flat += [round(float(x) / width, COORD_DECIMALS), round(float(y) / height, COORD_DECIMALS)]
    return flat


def build_outlines(arms: np.ndarray, joints: list[dict]) -> list[list[list[float] | None]]:
    """[frame][region] → outline or None."""
    frames = []
    for frame in range(arms.shape[0]):
        frames.append(
            [
                outline(biceps_mask(arms[frame, r], joints[r]["shoulder"][frame], joints[r]["elbow"][frame]))
                for r in range(arms.shape[1])
            ]
        )
    return frames
