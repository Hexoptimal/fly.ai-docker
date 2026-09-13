"""Do the fly's own feature detectors drive the right motor neurons?

Skips the photoreceptors and stimulates visual projection neurons directly:
    LC4 + LPLC2  (looming detectors, top inputs to the DNp01 giant fiber)
    LC10a        (object tracking used by males to chase during courtship)
on ONE side, then measures descending neurons on both sides.
Repeated over several noise seeds; reports mean change vs no stimulation
and a t-like score (difference / standard error).
"""
from __future__ import annotations

import sys

import numpy as np
import pyarrow.feather as feather

from flybrain import DATA, FlyBrain

SECONDS = 2.0
SEEDS = 6
READOUT = ["DNp01", "DNp10", "DNa02", "DNg13", "MDN", "DNg100", "DNg11", "pIP10"]
STIMULI = {"loom": ["LC4", "LPLC2"], "chase": ["LC10a"]}


def side_array(brain):
    ann = feather.read_table(DATA / "raw" / "body-annotations-male-cns-v1.0-minconf-0.5.feather",
                             columns=["bodyId", "somaSide", "rootSide"]).to_pandas()
    ann = ann.drop_duplicates("bodyId").set_index("bodyId").reindex(np.load(DATA / "brain.npz")["ids"])
    return ann["somaSide"].fillna(ann["rootSide"]).fillna("").astype(str).str.upper().to_numpy()


def run(brain, target, strength, readout, seed):
    brain.reset(seed)
    steps, warm = int(SECONDS / brain.dt), int(0.5 / brain.dt)
    counts = {k: 0 for k in readout}
    hit = np.zeros(brain.n, bool)
    for s in range(steps):
        if target is not None:
            brain.stimulate(target, strength)
        fired = brain.step(np.full(len(brain.visual), 0.45, np.float32))
        if s >= warm:
            hit[:] = False
            hit[fired] = True
            for k, idx in readout.items():
                counts[k] += hit[idx].sum()
    window = (steps - warm) * brain.dt
    return {k: counts[k] / len(readout[k]) / window for k in readout}


def main():
    brain = FlyBrain()
    side = side_array(brain)
    ct = brain.cell_type
    readout = {f"{t}_{s}": np.flatnonzero((ct == t) & (side == s)) for t in READOUT for s in "LR"}
    readout = {k: v for k, v in readout.items() if len(v)}
    targets = {f"{name}_L": np.flatnonzero(np.isin(ct, types) & (side == "L")) for name, types in STIMULI.items()}
    print({k: len(v) for k, v in targets.items()})
    regimes = [(0.18, 1.5), (0.16, 1.5), (0.14, 3.0), (0.12, 4.0)]
    if len(sys.argv) > 1:
        regimes = regimes[: int(sys.argv[1])]
    for tonic, gain in regimes:
        brain.tonic, brain.gain = tonic, gain
        base = [run(brain, None, 0, readout, seed) for seed in range(SEEDS)]
        overall = np.mean([np.mean([base[i][k] for k in readout]) for i in range(SEEDS)])
        print(f"\n=== tonic {tonic} gain {gain}  (mean readout rate at rest {overall:.1f} Hz)")
        for name, target in targets.items():
            for strength in (0.3, 0.8):
                stim = [run(brain, target, strength, readout, seed) for seed in range(SEEDS)]
                parts = []
                for k in readout:
                    d = np.array([stim[i][k] - base[i][k] for i in range(SEEDS)])
                    t = d.mean() / (d.std(ddof=1) / np.sqrt(SEEDS) + 1e-9)
                    mark = "*" if abs(t) > 3 and abs(d.mean()) >= 1 else " "
                    parts.append(f"{k}:{d.mean():+5.1f}{mark}")
                print(f"  stim {name:8s} x{strength}: " + " ".join(parts), flush=True)


if __name__ == "__main__":
    main()
