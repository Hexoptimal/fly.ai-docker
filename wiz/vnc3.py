"""Third VNC test, the first change to the model rather than a gain knob: a smaller time step.

wiz/vnc.py (uniform VNC tonic and gain, 0/20) and wiz/vnc2.py (gain on DN -> VNC and premotor -> MN,
0/12) could not make descending commands reach motor neurons without also driving them at rest. At
dt = 20 ms a spike needs a big share of a neuron's normalised input inside one step, so deep chains
fade. In flytalk.py, dt = 2 ms with a 4 ms refractory period let signal cross chains that were silent
at 20 ms. This tests the unmodified connectome at:

  dt 20 ms, no refractory   (control: should fail as in vnc.py's first row)
  dt 5 ms,  refractory 4 ms
  dt 2 ms,  refractory 4 ms

FlyBrain rescales tonic so resting voltage matches the 20 ms model. DN drive is scaled by dt / 20 ms so
the voltage injected per second is the same; the DN rates reached are printed. Pass criteria are exactly
those of wiz/vnc.py (REST, COMMAND, DISTINCT, LATERAL), fixed before this run, over 1 s windows. A
passing setting (smallest change first: 5 ms before 2 ms) is re-run on fresh seeds with 8 flies and only
that confirmation counts.

    python wiz/vnc3.py            (PYTHONPATH must include the repo root)
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from flybrain import FlyBrain
from probe import groups, run
from vnc import COMMANDS, DN_VOLTS, motor_keys, verdict

SETTINGS = [(0.020, 0.0), (0.005, 0.004), (0.002, 0.004)]


def measure(brain: FlyBrain, g: dict, vnc: np.ndarray, seed: int) -> dict:
    """vnc.measure with windows of 1 s whatever the step, and DN drive scaled to the step."""
    steps = round(1.0 / brain.dt)
    watch = np.unique(np.concatenate([*g.values(), vnc]))
    pos = {k: np.searchsorted(watch, v) for k, v in g.items()}
    vpos = np.searchsorted(watch, vnc)
    hz = lambda c: c / (steps * brain.dt)
    volts = DN_VOLTS * brain.dt / 0.020
    out = {}
    for i, name in enumerate(["rest", *COMMANDS]):
        brain.reset(seed=seed + i)
        run(brain, (), steps, watch)
        before = run(brain, (), steps, watch)
        if name == "rest":
            r = hz(before)
            out["rest"] = {"groups": {k: float(r[p].mean()) for k, p in pos.items()},
                           "vnc_mean": float(r[vpos].mean()), "vnc_saturated": float((r[vpos].mean(1) >= 40).mean())}
            continue
        types, side = COMMANDS[name]
        after = run(brain, [(brain.cells(types, side), volts)], steps, watch)
        row = {}
        for k, p in pos.items():
            d = hz(after[p]).mean(0) - hz(before[p]).mean(0)
            sd = d.std(ddof=1)
            row[k] = {"delta": float(d.mean()), "t": float(d.mean() / (sd / np.sqrt(len(d)))) if sd > 0 else 0.0}
        out[name] = row
    return out


def main() -> None:
    results = {"criteria": __doc__, "sweep": [], "confirm": None}
    out = Path("wiz/vnc3.json")
    for dt, refractory in SETTINGS:
        t0 = time.perf_counter()
        brain = FlyBrain(batch=4, sensory_input=False, dt=dt, refractory=refractory)
        g = groups(brain)
        keys = motor_keys(g)
        vnc = np.flatnonzero(np.isin(brain.superclass.astype(str), ["vnc_intrinsic", "vnc_motor"]))
        m = measure(brain, g, vnc, seed=30_000)
        v = verdict(m, keys)
        dn = {c: round(max(m[c][k]["delta"] for k in m[c] if k.startswith(c.split()[0])), 1) for c in COMMANDS}
        results["sweep"].append({"dt": dt, "refractory": refractory, **v, "dn_delta_hz": dn})
        print(f"dt {dt * 1000:g} ms refr {refractory * 1000:g} ms  {'PASS' if v['pass'] else 'fail'}  "
              f"DN reached {dn}  REST {v['REST']} (motor max {v['rest_max_motor_hz']} Hz, vnc {v['vnc_mean_hz']} Hz, "
              f"sat {v['vnc_saturated']})  COMMAND {v['COMMAND']} {v['best_motor_delta']}  DISTINCT {v['DISTINCT']} "
              f"{v['corr']}  LATERAL {v['LATERAL']} {v['lateral']}  ({time.perf_counter() - t0:.0f} s)", flush=True)
        out.write_text(json.dumps(results, indent=1))

    passing = [r for r in results["sweep"] if r["pass"] and r["dt"] < 0.020]
    if not passing:
        print("\nno smaller step passed; nothing to confirm", flush=True)
        return
    pick = max(passing, key=lambda r: r["dt"])
    print(f"\nconfirming dt {pick['dt'] * 1000:g} ms on fresh seeds, 8 flies", flush=True)
    brain = FlyBrain(batch=8, sensory_input=False, dt=pick["dt"], refractory=pick["refractory"])
    g = groups(brain)
    vnc = np.flatnonzero(np.isin(brain.superclass.astype(str), ["vnc_intrinsic", "vnc_motor"]))
    m = measure(brain, g, vnc, seed=96_000)
    v = verdict(m, motor_keys(g))
    results["confirm"] = {"dt": pick["dt"], "refractory": pick["refractory"], **v, "detail": m}
    print(f"CONFIRM {'PASS' if v['pass'] else 'FAIL'}: {json.dumps(v)}", flush=True)
    out.write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
