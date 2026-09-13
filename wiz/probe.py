"""Which motor neurons of the real connectome answer which stimulus, by side and leg segment.

This decides how the connectome drives Wiz's bones (wings -> arms, legs -> legs, neck -> head,
abdomen -> torso) from data instead of guesses. Each condition: a fresh batch of flies, 1 s to
settle, 1 s baseline, 1 s stimulus. Rates are per fly; t is the paired change over flies.

    python wiz/probe.py [--flies 8] [--out wiz/probe.json]
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from flybrain import FlyBrain

STEPS = 50  # 1 s at 20 ms

# stimuli: name -> list of (cell types, side or None, volts per step)
STIMULI = {
    "baseline": [],
    "loom L": [(["LPLC2"], "L", 0.8)],
    "loom R": [(["LPLC2"], "R", 0.8)],
    "threat L": [(["LC4"], "L", 0.8)],
    "threat R": [(["LC4"], "R", 0.8)],
    "target L": [(["LC10a"], "L", 0.6)],
    "target R": [(["LC10a"], "R", 0.6)],
    "food odour": [(["ORN_DM1", "ORN_DM2"], None, 0.8)],
    "geosmin": [(["ORN_DA2"], None, 0.8)],
    "CO2": [(["ORN_V"], None, 0.8)],
    "wind": [(["JO-CM", "JO-EV1", "JO-EV2", "JO-EV3", "JO-EV5"], None, 0.8)],
    "head bristles": [(["BM_InOm"], None, 0.8)],
    "taste": [(["LB3", "claw_tpGRN"], None, 0.8)],
    "leg touch": [("SNta*", None, 0.3)],
    # descending controls: do the commands reach the motor neurons at all?
    "DNg100 (forward)": [(["DNg100"], None, 0.8)],
    "DNa02 L (steer)": [(["DNa02"], "L", 0.8)],
    "DNa02 R (steer)": [(["DNa02"], "R", 0.8)],
    "DNp01 (escape)": [(["DNp01"], None, 0.8)],
    "MDN (backward)": [(["MDN"], None, 0.8)],
}

WING_POWER = ["DLMn a, b", "DLMn c-f", "DVMn 1a-c", "DVMn 2a, b", "DVMn 3a, b"]
WING_STEER = ["b1 MN", "b2 MN", "b3 MN", "i1 MN", "i2 MN", "iii1 MN", "iii3 MN", "hg1 MN", "hg2 MN", "hg3 MN",
              "hg4 MN", "hi1 MN", "hi2 MN", "hiii2 MN", "hDVM MN", "tp1 MN", "tp2 MN", "tpn MN", "ps1 MN",
              "MNwm35", "MNwm36"]
LEG_EXTEND = ["Ti extensor MN", "Tr extensor MN", "Sternotrochanter MN"]
LEG_FLEX = ["Ti flexor MN", "Acc. ti flexor MN", "Tr flexor MN", "Acc. tr flexor MN"]
LEG_TARSUS = ["Ta depressor MN", "Ta levator MN"]
# leg segment from the soma position along the VNC (third coordinate); the flight motor
# neurons (DLM, b1) sit at 80-85k, inside the T2 band, which is where the wings are
SEGMENTS = [("T1", -np.inf, 76000), ("T2", 76000, 100000), ("T3", 100000, np.inf)]


def groups(brain: FlyBrain) -> dict[str, np.ndarray]:
    ct, sc = brain.cell_type.astype(str), brain.superclass.astype(str)
    z = brain.positions[:, 2]
    out = {}
    for side in "LR":
        on = brain.side.astype(str) == side
        pick = lambda types: np.flatnonzero(np.isin(ct, types) & on)
        out[f"wing power {side}"] = pick(WING_POWER)
        out[f"wing steer {side}"] = pick(WING_STEER)
        for seg, lo, hi in SEGMENTS:
            band = (z >= lo) & (z < hi)
            for name, types in (("extend", LEG_EXTEND), ("flex", LEG_FLEX), ("tarsus", LEG_TARSUS)):
                out[f"{seg} {name} {side}"] = np.flatnonzero(np.isin(ct, types) & on & band)
        out[f"neck/head {side}"] = np.flatnonzero((sc == "cb_motor") & on)
        out[f"abdomen {side}"] = np.flatnonzero(np.char.startswith(ct, "MNad") & on)
        for dn in ("DNg100", "DNa02", "DNp01", "MDN"):
            out[f"{dn} {side}"] = pick([dn])
    return {k: v for k, v in out.items() if len(v)}


def cells(brain: FlyBrain, types, side) -> np.ndarray:
    if types == "SNta*":
        ct = brain.cell_type.astype(str)
        mask = np.char.startswith(ct, "SNta")
        if side:
            mask &= brain.side.astype(str) == side
        return np.flatnonzero(mask)
    return brain.cells(types, side)


def run(brain: FlyBrain, inject, steps: int, watch: np.ndarray) -> np.ndarray:
    """Spike counts (len(watch), batch) over `steps`."""
    where = np.full(brain.n, -1)
    where[watch] = np.arange(len(watch))
    counts = np.zeros((len(watch), brain.batch), np.int32)
    for _ in range(steps):
        for b, fired in enumerate(brain.step(inject=inject)):
            hit = where[fired]
            counts[hit[hit >= 0], b] += 1
    return counts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flies", type=int, default=8)
    ap.add_argument("--out", default="wiz/probe.json")
    args = ap.parse_args()

    brain = FlyBrain(batch=args.flies, sensory_input=False)
    g = groups(brain)
    watch = np.unique(np.concatenate(list(g.values())))
    pos = {k: np.searchsorted(watch, v) for k, v in g.items()}
    print(f"{brain.n:,} neurons, {args.flies} flies; groups: " + ", ".join(f"{k}={len(v)}" for k, v in g.items()))

    results = {}
    for i, (name, spec) in enumerate(STIMULI.items()):
        t0 = time.perf_counter()
        brain.reset(seed=1000 + i)
        run(brain, (), STEPS, watch)
        before = run(brain, (), STEPS, watch)
        inject = [(cells(brain, types, side), volts) for types, side, volts in spec]
        after = run(brain, inject, STEPS, watch)
        row = {}
        for k, p in pos.items():
            hz0 = before[p].mean(0) / (STEPS * brain.dt)   # per fly, mean over the group's neurons
            hz1 = after[p].mean(0) / (STEPS * brain.dt)
            d = hz1 - hz0
            t = float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d)))) if d.std() > 0 else (0.0 if d.mean() == 0 else float("inf"))
            row[k] = {"base_hz": round(float(hz0.mean()), 2), "stim_hz": round(float(hz1.mean()), 2),
                      "delta_hz": round(float(d.mean()), 2), "t": round(t, 1)}
        results[name] = row
        moved = sorted(((v["delta_hz"], k) for k, v in row.items() if abs(v["t"]) >= 4 and abs(v["delta_hz"]) >= 1),
                       key=lambda x: -abs(x[0]))
        print(f"\n{name}  ({time.perf_counter() - t0:.0f} s)")
        print("  " + ("; ".join(f"{k} {d:+.1f} Hz" for d, k in moved[:14]) or "no motor group moved (|t|>=4, >=1 Hz)"))

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"flies": args.flies, "steps": STEPS, "dt": brain.dt,
                                          "groups": {k: len(v) for k, v in g.items()}, "results": results}, indent=1))
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
