"""Lab test: show the fly objects and measure its motor (descending) neurons.

Each condition runs 3 s of simulated time; rates are spikes/s per neuron,
averaged over the last 2 s. Answers: does anything on the screen actually
reach the neurons we'd use as game controls, and is it left/right specific?
"""
from __future__ import annotations

import time

import numpy as np

from fly_brain import FlyBrain
from fly_eyes import Eyes, blob_for

SECONDS = 3.0


def run(brain: FlyBrain, scene, label: str) -> dict[str, float]:
    brain.reset(64)  # same noise every condition
    eyes = Eyes(brain.azimuth)
    steps = int(SECONDS / brain.dt)
    counts = {g: 0 for g in brain.groups}
    for s in range(steps):
        blobs = scene(s * brain.dt)
        fired = brain.step(None if blobs is None else eyes.drive(blobs))
        if s * brain.dt >= 1.0:
            hit = np.zeros(brain.n, bool)
            hit[fired] = True
            for g, idx in brain.groups.items():
                counts[g] += hit[idx].sum()
    window = SECONDS - 1.0
    rates = {g: counts[g] / (len(brain.groups[g]) * window) for g in counts}
    print(f"{label:28s} " + " ".join(f"{rates[g]:6.1f}" for g in brain.groups))
    return rates


def main():
    brain = FlyBrain()
    print(f"{'condition':28s} " + " ".join(f"{g:>6s}"[-6:] for g in brain.groups))
    t = time.perf_counter()
    conditions = {
        "no vision (dark)": lambda t: None,
        "blank bright field": lambda t: [],
        "object LEFT, still": lambda t: [blob_for(-60, 30, 0.8)],
        "object RIGHT, still": lambda t: [blob_for(60, 30, 0.8)],
        "object LEFT, looming": lambda t: [blob_for(-110 + 35 * t, 30, 0.8)],
        "object RIGHT, looming": lambda t: [blob_for(110 - 35 * t, 30, 0.8)],
        "bar sweeping L->R": lambda t: [blob_for(-110 + 73 * t, 12, 0.9)],
    }
    for label, scene in conditions.items():
        run(brain, scene, label)
    print(f"({time.perf_counter() - t:.0f} s wall time)")


if __name__ == "__main__":
    main()
