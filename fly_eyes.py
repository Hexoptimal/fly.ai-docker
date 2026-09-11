"""What the fly "sees": a 1-D panorama projected onto its 6,006 photoreceptors.

Each photoreceptor has an azimuth (-1 = far left, +1 = far right) estimated
from the MaleCNS optic-column tables. Objects are dark silhouettes on a bright
background; closer objects cover more of the eye (so an approaching one looms).
Drive formula matches fly64: brightness plus absolute change since last step.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

BACKGROUND = 0.9


@dataclass
class Blob:
    center: float      # azimuth, -1..1
    half_width: float  # azimuth units
    darkness: float    # 0 = invisible, 1 = black


def render(azimuth: np.ndarray, blobs: list[Blob]) -> np.ndarray:
    lum = np.full(len(azimuth), BACKGROUND, np.float32)
    for b in blobs:
        inside = np.abs(azimuth - b.center) <= b.half_width
        lum[inside] = np.minimum(lum[inside], BACKGROUND * (1 - b.darkness))
    return lum


class Eyes:
    def __init__(self, azimuth: np.ndarray):
        self.azimuth = azimuth
        self.previous: np.ndarray | None = None

    def drive(self, blobs: list[Blob]) -> np.ndarray:
        lum = render(self.azimuth, blobs)
        change = np.zeros_like(lum) if self.previous is None else np.abs(lum - self.previous)
        self.previous = lum
        return np.clip(0.45 * lum + 1.6 * change, 0, 1)


LOOM_GAIN = 10.0   # angular growth per game frame -> extra voltage
CHASE_BASE, CHASE_GAIN = 0.6, 0.2


class FeatureDetectors:
    """Shortcut past the lamina, which a spiking model can't relay (its neurons
    are graded in real flies): drive the fly's own looming detectors (LC4,
    LPLC2) and object-tracking neurons (LC10a) on the side where things are.
    As in Eon's embodied fly, this visual front end is a model; everything
    downstream of these neurons is the connectome.
    """

    def __init__(self, brain):
        self.loom = {s: brain.cells(["LC4", "LPLC2"], s) for s in "LR"}
        self.chase = {s: brain.cells(["LC10a"], s) for s in "LR"}
        self.previous: dict = {}
        self.last = {"loomL": 0.0, "loomR": 0.0, "chaseL": 0.0, "chaseR": 0.0}

    def inject(self, objects: list[tuple[str, float, float]]) -> list:
        """objects: (stable key, dx from the fly in screen units, size). Call once per game frame."""
        loom = {"L": 0.0, "R": 0.0}
        chase = {"L": 0.0, "R": 0.0}
        seen = {}
        for key, dx, size in objects:
            s = "L" if dx < 0 else "R"
            angle = size / max(abs(dx), 8.0)
            loom[s] = max(loom[s], angle - self.previous.get(key, angle))
            seen[key] = angle
            if key == "opp":
                chase[s] = angle
        self.previous = seen
        out = []
        self.last = {"loomL": 0.0, "loomR": 0.0, "chaseL": 0.0, "chaseR": 0.0}
        for s in "LR":
            if loom[s] > 0:
                amount = min(0.8, loom[s] * LOOM_GAIN)
                out.append((self.loom[s], amount))
                self.last[f"loom{s}"] = amount
            if chase[s] > 0:
                amount = min(0.8, CHASE_BASE + CHASE_GAIN * chase[s])
                out.append((self.chase[s], amount))
                self.last[f"chase{s}"] = amount
        return out


def blob_for(dx: float, size: float, darkness: float) -> Blob:
    """An object `dx` world units to the side (screen coordinates) of the fly."""
    distance = max(abs(dx), 8.0)
    return Blob(center=float(np.clip(dx / 110.0, -1, 1)),
                half_width=float(np.clip(size / distance * 0.5, 0.03, 0.7)),
                darkness=darkness)
