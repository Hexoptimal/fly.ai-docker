"""Can the VNC relay descending commands to the motor neurons? A calibration experiment.

wiz/probe.py found that driving DNg100, DNa02, DNp01 or MDN at ~25 Hz moves no motor neuron group
(< 0.6 Hz): with incoming weights normalised to sum to 1, the DN -> premotor -> MN chain dies out.
This sweeps two knobs on the VNC stage only (superclasses vnc_intrinsic and vnc_motor), without
touching the flybrain package:

  tonic+  extra constant voltage per step for VNC neurons (global tonic is 0.14)
  gain x  multiplier on every synapse onto a VNC neuron

Pass criteria, fixed before the first run (all must hold):
  REST     every motor group rests at <= 5 Hz; VNC intrinsic mean <= 10 Hz; <= 1% of VNC neurons >= 40 Hz
  COMMAND  each of DNg100, DNp01, MDN, DNa02 L, DNa02 R raises some motor group by >= 3 Hz with t >= 4
  DISTINCT the motor responses (delta per group) of DNg100, DNp01 and MDN correlate < 0.8 pairwise
  LATERAL  DNa02 L and DNa02 R give (left-side minus right-side motor delta) of opposite sign, each >= 2 Hz
Sweep on one set of seeds with 4 flies; the passing config with the smallest change (lowest tonic+,
then lowest gain x) is re-run on fresh seeds with 8 flies, and only that confirmation counts.

    python wiz/vnc.py            (PYTHONPATH must include the repo root)
"""
from __future__ import annotations

import itertools
import json
import time
from pathlib import Path

import numpy as np

from flybrain import FlyBrain
from probe import STEPS, groups, run

TONIC = [0.0, 0.01, 0.02, 0.03, 0.035]
GAIN = [1.0, 2.0, 4.0, 8.0]
COMMANDS = {"DNg100": (["DNg100"], None), "DNp01": (["DNp01"], None), "MDN": (["MDN"], None),
            "DNa02 L": (["DNa02"], "L"), "DNa02 R": (["DNa02"], "R")}
DN_VOLTS = 0.8   # ~25 Hz in the DNs, the rate looming itself evokes in DNp01 (probe.json)


def motor_keys(g: dict) -> list[str]:
    return [k for k in g if not k.startswith(("DNg100", "DNa02", "DNp01", "MDN"))]


def measure(brain: FlyBrain, g: dict, vnc: np.ndarray, tonic: float, seed: int) -> dict:
    watch = np.unique(np.concatenate([*g.values(), vnc]))
    pos = {k: np.searchsorted(watch, v) for k, v in g.items()}
    vpos = np.searchsorted(watch, vnc)
    extra = [(vnc, tonic)] if tonic else []
    hz = lambda c: c / (STEPS * brain.dt)
    out = {}
    for i, name in enumerate(["rest", *COMMANDS]):
        brain.reset(seed=seed + i)
        run(brain, extra, STEPS, watch)
        before = run(brain, extra, STEPS, watch)
        if name == "rest":
            r = hz(before)
            out["rest"] = {"groups": {k: float(r[p].mean()) for k, p in pos.items()},
                           "vnc_mean": float(r[vpos].mean()), "vnc_saturated": float((r[vpos].mean(1) >= 40).mean())}
            continue
        types, side = COMMANDS[name]
        after = run(brain, extra + [(brain.cells(types, side), DN_VOLTS)], STEPS, watch)
        row = {}
        for k, p in pos.items():
            d = hz(after[p]).mean(0) - hz(before[p]).mean(0)
            sd = d.std(ddof=1)
            row[k] = {"delta": float(d.mean()), "t": float(d.mean() / (sd / np.sqrt(len(d)))) if sd > 0 else 0.0}
        out[name] = row
    return out


def verdict(m: dict, keys: list[str]) -> dict:
    rest = m["rest"]
    ok_rest = all(rest["groups"][k] <= 5 for k in keys) and rest["vnc_mean"] <= 10 and rest["vnc_saturated"] <= 0.01
    moved = {c: max((m[c][k]["delta"] for k in keys if m[c][k]["t"] >= 4), default=0.0) for c in COMMANDS}
    ok_command = all(v >= 3 for v in moved.values())
    vec = {c: np.array([m[c][k]["delta"] for k in keys]) for c in ("DNg100", "DNp01", "MDN")}
    corr = {f"{a}~{b}": float(np.corrcoef(vec[a], vec[b])[0, 1]) if vec[a].std() and vec[b].std() else 1.0
            for a, b in itertools.combinations(vec, 2)}
    ok_distinct = all(c < 0.8 for c in corr.values())
    lat = {c: sum(m[c][k]["delta"] for k in keys if k.endswith(" L")) - sum(m[c][k]["delta"] for k in keys if k.endswith(" R"))
           for c in ("DNa02 L", "DNa02 R")}
    ok_lateral = np.sign(lat["DNa02 L"]) != np.sign(lat["DNa02 R"]) and min(abs(v) for v in lat.values()) >= 2
    return {"REST": bool(ok_rest), "COMMAND": bool(ok_command), "DISTINCT": bool(ok_distinct), "LATERAL": bool(ok_lateral),
            "pass": bool(ok_rest and ok_command and ok_distinct and ok_lateral),
            "rest_max_motor_hz": round(max(rest["groups"][k] for k in keys), 2), "vnc_mean_hz": round(rest["vnc_mean"], 2),
            "vnc_saturated": round(rest["vnc_saturated"], 4), "best_motor_delta": {c: round(v, 2) for c, v in moved.items()},
            "corr": {k: round(v, 2) for k, v in corr.items()}, "lateral": {k: round(v, 2) for k, v in lat.items()}}


def configure(brain: FlyBrain, base: np.ndarray, onto_vnc: np.ndarray, gain: float) -> None:
    brain.weights[:] = base
    brain.weights[onto_vnc] *= np.float32(gain)


def main() -> None:
    results = {"criteria": __doc__, "sweep": [], "confirm": None}
    out = Path("wiz/vnc.json")

    brain = FlyBrain(batch=4, sensory_input=False)
    g = groups(brain)
    keys = motor_keys(g)
    sc = brain.superclass.astype(str)
    is_vnc = np.isin(sc, ["vnc_intrinsic", "vnc_motor"])
    vnc = np.flatnonzero(is_vnc)
    base = brain.weights.copy()
    onto_vnc = is_vnc[brain.indices]
    print(f"VNC neurons {len(vnc):,}; synapses onto them {int(onto_vnc.sum()):,}", flush=True)

    for tonic, gain in itertools.product(TONIC, GAIN):
        t0 = time.perf_counter()
        configure(brain, base, onto_vnc, gain)
        v = verdict(measure(brain, g, vnc, tonic, seed=10_000), keys)
        results["sweep"].append({"tonic": tonic, "gain": gain, **v})
        print(f"tonic+{tonic:<5} gain x{gain:<3}  {'PASS' if v['pass'] else 'fail'}  "
              f"REST {v['REST']} (motor max {v['rest_max_motor_hz']} Hz, vnc {v['vnc_mean_hz']} Hz, sat {v['vnc_saturated']})  "
              f"COMMAND {v['COMMAND']} {v['best_motor_delta']}  DISTINCT {v['DISTINCT']} {v['corr']}  "
              f"LATERAL {v['LATERAL']} {v['lateral']}  ({time.perf_counter() - t0:.0f} s)", flush=True)
        out.write_text(json.dumps(results, indent=1))

    passing = [r for r in results["sweep"] if r["pass"]]
    if not passing:
        print("\nno config passed the sweep; nothing to confirm", flush=True)
        out.write_text(json.dumps(results, indent=1))
        return
    pick = min(passing, key=lambda r: (r["tonic"], r["gain"]))
    print(f"\nconfirming tonic+{pick['tonic']} gain x{pick['gain']} on fresh seeds, 8 flies", flush=True)
    brain = FlyBrain(batch=8, sensory_input=False)
    base = brain.weights.copy()
    configure(brain, base, onto_vnc, pick["gain"])
    m = measure(brain, g, vnc, pick["tonic"], seed=90_000)
    v = verdict(m, keys)
    results["confirm"] = {"tonic": pick["tonic"], "gain": pick["gain"], **v, "detail": m}
    print(f"CONFIRM {'PASS' if v['pass'] else 'FAIL'}: {json.dumps(v)}", flush=True)
    out.write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
