"""Live captions: decode which context a cast member's buzz currently reads as.

Reuses flytalk.py's own context-decoding pipeline almost directly: fit a
flybrain.reservoir.Readout (ridge, cross-validated via folds) on song-envelope
features from a short calibration run (flytalk.speak, the same trial loop
flytalk.py itself uses), then apply it to a rolling window of live envelope to
caption the stream. This is a genuine decode of the signal, not an echo of
whichever context happens to be injected into a column -- it can legitimately
read low-confidence, or as a context other than the one actually driving it.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from flybrain.reservoir import Readout  # noqa: E402  (path insert must come first)
from flytalk import BIN_S, CONTEXTS, NAMES, sound_of, speak, windows  # noqa: E402

CALIBRATION_TRIALS = 8

# Bump this when calibrate()'s own logic changes (feature binning, the ridge grid, the rest
# baseline) in a way that would make an old cached readout stale even though CONTEXTS/dt/trials
# didn't change -- fingerprint() has no way to see that on its own, same limitation as
# flybook/worker/calibrate.py's config-only staleness check.
CALIBRATION_VERSION = 1

MODEL_DIR = Path(__file__).resolve().parent / "model"
READOUT_PATH = MODEL_DIR / "readout.npz"
META_PATH = MODEL_DIR / "readout.json"


def fingerprint(dt_step: float, trials: int, seed: int) -> dict:
    """Everything that changes what calibrate() would produce. Compared with
    `==` against a cached run's fingerprint (a plain dict of JSON-safe values,
    same approach as flybook/worker/tick.py's `vocab["config"] != CONFIG` check)
    to decide whether the cache is still valid."""
    return {"version": CALIBRATION_VERSION, "contexts": CONTEXTS, "dt": dt_step,
            "trials": trials, "seed": seed}


def calibrate(brain, trials: int = CALIBRATION_TRIALS, seed: int = 7) -> tuple[Readout, float]:
    """Runs a short calibration on `brain` (reusing flytalk.speak's own trial
    loop -- it resets and re-seeds the brain each trial) to fit a context
    readout from song-envelope features. Returns (readout, rest). Leaves the
    brain reset but NOT re-seeded for the live run; call brain.reset(seed) again
    before streaming."""
    data = speak(brain, trials, seed=seed, tag="radio-calibration")
    W, S = windows(brain.dt)
    rest = float(data["songs"][:, int(round(0.1 / brain.dt)):W].sum(-1).mean())
    loud = sound_of(data["songs"], rest)
    features = bin_envelope(loud[:, W:W + S], brain.dt)
    y = np.eye(len(NAMES))[data["labels"]]
    readout = Readout.fit(features, y, kind="ridge", components=(5, 20, 60), lambdas=(0.1, 1.0, 10.0))
    print(f"radio: caption readout calibrated, cross-validated score {readout.cv_score:.3f} "
          f"({readout.components} components, lambda {readout.lam:g})")
    return readout, rest


def calibrate_cached(brain, trials: int = CALIBRATION_TRIALS, seed: int = 7,
                      cache: bool = True, force: bool = False) -> tuple[Readout, float]:
    """Like `calibrate()`, but reuses a saved readout from `radio/model/` when
    its fingerprint (CONTEXTS, dt, trials, seed, CALIBRATION_VERSION) matches --
    so a redeployed/restarted station doesn't pay the 1-2 minute calibration
    cost every cold start (see radio/README.md's "On the site" section).
    `force=True` (or deleting radio/model/) always recalibrates and, if
    `cache`, overwrites the saved copy."""
    # round-tripped through JSON so it's plain lists/numbers throughout, same shape a cached
    # fingerprint comes back as after json.loads -- otherwise CONTEXTS' tuples would never equal
    # the lists JSON deserializes them into, and the cache would always look stale.
    fp = json.loads(json.dumps(fingerprint(brain.dt, trials, seed)))
    if cache and not force and META_PATH.exists() and READOUT_PATH.exists():
        meta = json.loads(META_PATH.read_text())
        if meta.get("fingerprint") == fp:
            print(f"radio: using cached caption readout from {meta.get('trained_at', 'unknown time')} "
                  f"(cross-validated score {meta['cv_score']:.3f})", flush=True)
            return Readout.load(READOUT_PATH), float(meta["rest"])
        print("radio: cached readout is stale (contexts/dt/trials/seed changed) -- recalibrating", flush=True)

    readout, rest = calibrate(brain, trials=trials, seed=seed)
    if cache:
        MODEL_DIR.mkdir(exist_ok=True)
        readout.save(READOUT_PATH)
        META_PATH.write_text(json.dumps({
            "fingerprint": fp, "rest": rest, "cv_score": readout.cv_score,
            "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        }, indent=1))
        print(f"radio: cached the calibrated readout to {READOUT_PATH}", flush=True)
    return readout, rest


def bin_envelope(loudness: np.ndarray, dt: float, bin_s: float = BIN_S) -> np.ndarray:
    """(n, steps) step-wise loudness -> (n, bins) BIN_S-binned loudness, same
    convention as flytalk's own `envelope()`/`song_features()`."""
    per = max(1, int(round(bin_s / dt)))
    usable = loudness.shape[1] - loudness.shape[1] % per
    return loudness[:, :usable].reshape(loudness.shape[0], -1, per).sum(2)


def caption(readout: Readout, loudness_window: np.ndarray, dt: float) -> tuple[str, float]:
    """loudness_window: (steps,) recent per-step loudness for one cast member,
    the same length used at calibration time (windows(dt)[1] steps). Returns
    (context name, confidence 0..1)."""
    feats = bin_envelope(loudness_window[None, :].astype(np.float32), dt)
    probs = np.clip(readout.predict(feats)[0], 0.0, None)
    total = float(probs.sum())
    probs = probs / total if total > 0 else np.full(len(NAMES), 1.0 / len(NAMES))
    i = int(np.argmax(probs))
    return NAMES[i], float(probs[i])


if __name__ == "__main__":
    import argparse

    from flybrain import FlyBrain

    p = argparse.ArgumentParser(description="calibrate + sanity-check the caption readout")
    p.add_argument("--device", default="auto")
    p.add_argument("--trials", type=int, default=CALIBRATION_TRIALS)
    p.add_argument("--cache", action="store_true",
                   help="also save the result to radio/model/readout.npz, "
                        "so radio/server.py's calibrate_cached() picks it up on the next start "
                        "(e.g. before deploying -- see radio/README.md's \"On the site\" section)")
    args = p.parse_args()

    brain = FlyBrain(device=args.device, batch=8, seed=1, dt=0.020, sensory_input=False)
    readout, rest = calibrate(brain, trials=args.trials)
    print(f"rest {rest:.3f} wing spikes/step")
    if args.cache:
        MODEL_DIR.mkdir(exist_ok=True)
        readout.save(READOUT_PATH)
        META_PATH.write_text(json.dumps({
            "fingerprint": json.loads(json.dumps(fingerprint(brain.dt, args.trials, 7))),
            "rest": rest, "cv_score": readout.cv_score,
            "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        }, indent=1))
        print(f"cached to {READOUT_PATH}")

    W, S = windows(brain.dt)
    correct = 0
    for c, name in enumerate(NAMES):
        brain.reset(99 + c)
        songs = np.zeros((W + S, 2), np.float32)
        from flytalk import Counter, context_injector, wing_groups
        wing = wing_groups(brain)
        count = Counter(brain, {k: v for k, v in wing.items() if len(v)})
        inject = context_injector(brain)
        ctx = np.full(brain.batch, c)
        for s in range(W + S):
            fired = brain.step(inject=inject(ctx) if s >= W else ())
            songs[s] = count(fired)[:1, :2]
        loud = sound_of(songs[None], rest)[0]
        text, conf = caption(readout, loud[W:W + S], brain.dt)
        ok = "OK " if text == name else "MISS"
        print(f"  injected {name:9s} -> reads {text:9s} ({conf:.0%})  {ok}")
        correct += text == name
    print(f"{correct}/{len(NAMES)} single-fly spot checks matched their injected context")
