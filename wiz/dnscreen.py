"""Does anything Wiz can sense drive a walking command? A screen of all 1,314 descending neurons.

wiz/probe.py found that looming drives DNp01 and targets drive DNa02, but nothing drove DNg100 or MDN,
so Wiz never walks. This screens every descending neuron type (by side) against the inputs Wiz actually
has: LPLC2 looming, LC4 threat, LPLC1 small moving objects, LC10a targets (each side, and looming on
both sides at once) and tarsal touch (SNta, each side), at 0.5 V per step (Vision caps at 0.8).

Criterion, fixed before the run: WALK FOUND if any of these stimuli raises a forward-walking type
(DNg100 = BDN2, oDN1, DNp09) or a backward-walking type (MDN) on either side by >= 3 Hz with t >= 4
over 8 flies. Types from the literature (Bidaye et al. 2014, 2020; Sen et al. 2017). Every responder
(>= 3 Hz, t >= 4) is also listed, whatever its known role.

Second run (added before running it): the same criterion over senses Wiz does not have yet: food odour,
vinegar, geosmin, CO2 and cVA receptor neurons, wind (Johnston's organ), taste and head bristles. A
walking responder there would be a reason to give him that sense.

    python wiz/dnscreen.py            (PYTHONPATH must include the repo root)
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from flybrain import FlyBrain
from probe import STEPS, cells, run

WALK = {"forward": ["DNg100", "oDN1", "DNp09"], "backward": ["MDN"]}
VOLTS = 0.5
STIMULI = {
    "loom L": [(["LPLC2"], "L")], "loom R": [(["LPLC2"], "R")], "loom both": [(["LPLC2"], None)],
    "threat L": [(["LC4"], "L")], "threat R": [(["LC4"], "R")],
    "small L": [(["LPLC1"], "L")], "small R": [(["LPLC1"], "R")],
    "target L": [(["LC10a"], "L")], "target R": [(["LC10a"], "R")], "target both": [(["LC10a"], None)],
    "touch L": [("SNta*", "L")], "touch R": [("SNta*", "R")],
    # senses Wiz does not have yet
    "food odour": [(["ORN_DM1", "ORN_DM2"], None)], "vinegar": [(["ORN_VL2a"], None)],
    "geosmin": [(["ORN_DA2"], None)], "CO2": [(["ORN_V"], None)], "cVA": [(["ORN_DA1", "ORN_VA1d"], None)],
    "wind": [(["JO-CM", "JO-EV1", "JO-EV2", "JO-EV3", "JO-EV5"], None)],
    "taste": [(["LB3", "claw_tpGRN"], None)], "head bristles": [(["BM_InOm"], None)],
}


def main() -> None:
    brain = FlyBrain(batch=8, sensory_input=False)
    ct, side = brain.cell_type.astype(str), brain.side.astype(str)
    dn = np.flatnonzero(np.isin(brain.superclass.astype(str), ["descending_neuron", "descending_neuron_tbc"]))
    keys = sorted({(ct[i] or "untyped", side[i] or "?") for i in dn})
    groups = {f"{t} {s}": dn[((ct[dn] == t) | ((ct[dn] == "") & (t == "untyped"))) & ((side[dn] == s) | ((side[dn] == "") & (s == "?")))]
              for t, s in keys}
    groups = {k: v for k, v in groups.items() if len(v)}
    present = {role: [t for t in types if (ct == t).any()] for role, types in WALK.items()}
    print(f"{len(dn):,} descending neurons in {len(groups)} type/side groups; walking types present: {present}", flush=True)

    watch = np.unique(dn)
    pos = {k: np.searchsorted(watch, v) for k, v in groups.items()}
    hz = lambda c: c / (STEPS * brain.dt)
    results, found = {}, []
    for i, (name, spec) in enumerate(STIMULI.items()):
        t0 = time.perf_counter()
        brain.reset(seed=5000 + i)
        run(brain, (), STEPS, watch)
        before = run(brain, (), STEPS, watch)
        after = run(brain, [(cells(brain, types, s), VOLTS) for types, s in spec], STEPS, watch)
        row = {}
        for k, p in pos.items():
            d = hz(after[p]).mean(0) - hz(before[p]).mean(0)
            sd = d.std(ddof=1)
            t = float(d.mean() / (sd / np.sqrt(len(d)))) if sd > 0 else 0.0
            if d.mean() >= 3 and t >= 4:
                row[k] = {"base_hz": round(float(hz(before[p]).mean()), 2), "delta_hz": round(float(d.mean()), 2), "t": round(t, 1)}
        results[name] = row
        walkers = [k for k in row if k.rsplit(" ", 1)[0] in WALK["forward"] + WALK["backward"]]
        found += [(name, k) for k in walkers]
        top = sorted(row.items(), key=lambda kv: -kv[1]["delta_hz"])[:12]
        print(f"\n{name} ({time.perf_counter() - t0:.0f} s): {len(row)} DN groups up; walking: {walkers or 'none'}", flush=True)
        print("  " + "; ".join(f"{k} +{v['delta_hz']} Hz" for k, v in top), flush=True)

    verdict = "WALK FOUND" if found else "NO WALKING COMMAND"
    print(f"\n{verdict}: {found}", flush=True)
    Path("wiz/dnscreen.json").write_text(json.dumps({"criterion": __doc__, "volts": VOLTS, "walking_types_present": present,
                                                     "verdict": verdict, "found": found, "responders": results}, indent=1))


if __name__ == "__main__":
    main()
