"""Minimal end-to-end use of flybrain/reservoir.py, with synthetic data instead of a
game -- no recordings, no game logic, nothing task-specific. Shows the whole
loop: encoder -> frozen brain -> trace -> trained readout.

The task: on each of many trials, drive either the left or right chase
neurons (LC10a) at a random strength in [0.4, 1.0] for the whole trial. Two
readouts are trained on the resulting descending-neuron trace, averaged over
the trial: a classifier for "which side" (logistic) and a regressor for "how
strong" (ridge). Neither is hand-coded -- both are linear fits on the brain's
own activity, exactly like the punch/movement readouts in
sshfighter/reservoir.py, just on invented labels instead of game outcomes.

This does not prove anything about the fly connectome's suitability for
arbitrary tasks (see ROADMAP.md #2 for that question, unanswered). It only
demonstrates that the module's API works end to end.

    python flyreservoir_example.py
"""
from __future__ import annotations

import numpy as np

from flybrain.reservoir import Readout, Trace, run
from flybrain import FlyBrain


def main() -> None:
    rng = np.random.default_rng(0)
    brain = FlyBrain(device="auto", seed=1)
    trace = Trace(brain, types=["descending_neuron"], tau=0.1)

    n_trials, steps_per_trial = 150, 25
    sides, strengths, X = [], [], []
    for _ in range(n_trials):
        side = rng.choice(["L", "R"])
        strength = float(rng.uniform(0.4, 1.0))
        idx = brain.cells(["LC10a"], side=side)

        def encode(t, idx=idx, strength=strength):
            return [(idx, strength)] if t < steps_per_trial else []

        activity = run(brain, steps_per_trial, encode=encode, trace=trace)
        X.append(activity.mean(0))       # trace averaged over the trial
        sides.append(1.0 if side == "R" else 0.0)
        strengths.append(strength)
        trace.reset()

    X = np.stack(X)
    sides = np.asarray(sides)
    strengths = np.asarray(strengths)

    split = n_trials * 3 // 4
    side_readout = Readout.fit(X[:split], sides[:split], kind="logistic", verbose=True)
    strength_readout = Readout.fit(X[:split], strengths[:split], kind="ridge", verbose=True)

    p_side = side_readout.predict(X[split:])
    acc = ((p_side >= 0.5) == sides[split:]).mean()
    print(f"held-out side classification accuracy: {acc:.0%}  (n={n_trials - split}, chance 50%)")

    p_strength = strength_readout.predict(X[split:])
    err = np.abs(p_strength - strengths[split:]).mean()
    baseline_err = np.abs(strengths[:split].mean() - strengths[split:]).mean()
    print(f"held-out strength: mean abs error {err:.3f}  (predicting the training mean gets {baseline_err:.3f})")


if __name__ == "__main__":
    main()
