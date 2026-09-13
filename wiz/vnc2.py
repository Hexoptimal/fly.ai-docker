"""Second VNC calibration: amplify only the relay, not the whole VNC.

wiz/vnc.py raised tonic and synaptic gain on every VNC neuron: 0/20 settings passed, because any gain
that let commands through also drove resting motor neurons to 29-36 Hz. This amplifies only the two
links of the command chain:

  dn x   synapses from descending neurons onto VNC neurons (DN -> premotor)
  pm x   synapses from VNC interneurons onto VNC motor neurons (premotor -> motor neuron)

These multipliers break the "incoming weights sum to 1" rule for the neurons they touch; that is the
point of the test. Pass criteria are exactly those of wiz/vnc.py (REST, COMMAND, DISTINCT, LATERAL),
fixed before this run; the smallest passing setting (lowest dn x, then pm x) is re-run on fresh seeds
with 8 flies and only that confirmation counts.

    python wiz/vnc2.py            (PYTHONPATH must include the repo root)
"""
from __future__ import annotations

import itertools
import json
import time
from pathlib import Path

import numpy as np

from flybrain import FlyBrain
from probe import groups
from vnc import measure, motor_keys, verdict

DN_GAIN = [1.0, 4.0, 16.0, 64.0]
PM_GAIN = [1.0, 4.0, 16.0]


def masks(brain: FlyBrain) -> tuple[np.ndarray, np.ndarray]:
    sc = brain.superclass.astype(str)
    pre = np.repeat(np.arange(brain.n), np.diff(brain.indptr))   # CSC: column = presynaptic
    post = brain.indices
    is_dn = np.isin(sc, ["descending_neuron", "descending_neuron_tbc"])
    is_vnc = np.isin(sc, ["vnc_intrinsic", "vnc_motor"])
    return is_dn[pre] & is_vnc[post], (sc[pre] == "vnc_intrinsic") & (sc[post] == "vnc_motor")


def configure(brain: FlyBrain, base: np.ndarray, dn_out: np.ndarray, pm_mn: np.ndarray, dn: float, pm: float) -> None:
    brain.weights[:] = base
    brain.weights[dn_out] *= np.float32(dn)
    brain.weights[pm_mn] *= np.float32(pm)


def main() -> None:
    results = {"criteria": __doc__, "sweep": [], "confirm": None}
    out = Path("wiz/vnc2.json")
    brain = FlyBrain(batch=4, sensory_input=False)
    g = groups(brain)
    keys = motor_keys(g)
    vnc = np.flatnonzero(np.isin(brain.superclass.astype(str), ["vnc_intrinsic", "vnc_motor"]))
    base = brain.weights.copy()
    dn_out, pm_mn = masks(brain)
    print(f"DN -> VNC synapses {int(dn_out.sum()):,}; premotor -> MN synapses {int(pm_mn.sum()):,}", flush=True)

    for dn, pm in itertools.product(DN_GAIN, PM_GAIN):
        t0 = time.perf_counter()
        configure(brain, base, dn_out, pm_mn, dn, pm)
        v = verdict(measure(brain, g, vnc, 0.0, seed=20_000), keys)
        results["sweep"].append({"dn_gain": dn, "pm_gain": pm, **v})
        print(f"dn x{dn:<4} pm x{pm:<4}  {'PASS' if v['pass'] else 'fail'}  "
              f"REST {v['REST']} (motor max {v['rest_max_motor_hz']} Hz, vnc {v['vnc_mean_hz']} Hz, sat {v['vnc_saturated']})  "
              f"COMMAND {v['COMMAND']} {v['best_motor_delta']}  DISTINCT {v['DISTINCT']} {v['corr']}  "
              f"LATERAL {v['LATERAL']} {v['lateral']}  ({time.perf_counter() - t0:.0f} s)", flush=True)
        out.write_text(json.dumps(results, indent=1))

    passing = [r for r in results["sweep"] if r["pass"]]
    if not passing:
        print("\nno setting passed the sweep; nothing to confirm", flush=True)
        return
    pick = min(passing, key=lambda r: (r["dn_gain"], r["pm_gain"]))
    print(f"\nconfirming dn x{pick['dn_gain']} pm x{pick['pm_gain']} on fresh seeds, 8 flies", flush=True)
    brain = FlyBrain(batch=8, sensory_input=False)
    base = brain.weights.copy()
    configure(brain, base, dn_out, pm_mn, pick["dn_gain"], pick["pm_gain"])
    m = measure(brain, g, vnc, 0.0, seed=95_000)
    v = verdict(m, keys)
    results["confirm"] = {"dn_gain": pick["dn_gain"], "pm_gain": pick["pm_gain"], **v, "detail": m}
    print(f"CONFIRM {'PASS' if v['pass'] else 'FAIL'}: {json.dumps(v)}", flush=True)
    out.write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
