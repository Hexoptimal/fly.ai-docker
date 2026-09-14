"""What counts as 'a neighbour really did something to this fly'? Measure label rules on live-like patches.

Why (2026-09-14): 2,001 live posts had 'mate' as the truth 916 times, 869 of them from a neighbour, and 781 of those
from 8 restless/excitable flies. patch.cause labels a fly with a neighbour's channel when that input peaks at
SOCIAL_MIN (0.02) on any single step. Lone flies with live settings send the 'target' (moving fly) signal on
0-5% of resting steps and only 2-20% under a real mate stimulus, so one or two resting twitches from a neighbour
label a fly 'mate'. The translator can't see that (reads barely rose with input strength), and live mate
precision was 0.79 against 0.96 on the readout.py test set, whose settings were only the presets.

Episodes: built like live ticks (patch.PatchRunner, 3-12 flies clustered in a patch, the event on one fly), with
settings drawn 20% standard, 30% presets, 30% bred from two presets (settings.breed, as mating does) and 20% the
live flies' own settings (flies.json). Each fly stores its DN counts, wing rate, direct hit, and per channel the
peak and the total neighbour input. Behaviour is identical under every rule; only the labels differ.

Rules (label a fly with the strongest channel, by total input, among channels that reach the rule):
  R0  peak input on one step >= 0.02 (live)
  R1  total input over the 1 s window >= 5% of a full direct stimulus
  R2  total >= 10%
  R3  total >= 25%
For each rule: translator refit on lone-fly runs + training patches labelled by that rule, per-word thresholds
picked on validation (readout.pick_thresholds: lowest score >= 85% precise with >= 5 reads, then raised to 95% as
in the deployed variant D), actions judged against the lone-fly standard rest (as deployed).

Pass criteria, fixed before running (readout.py C1-C6 plus):
  M1  posted 'mate' is >= 85% precise
  M2  'mate' stays postable with >= 5 posts on the set
  M3  flies whose label is 'nothing' post a word <= 10%
Selection: on the VALIDATION set, the passing rule with the lowest threshold (it keeps the most real social
events); ties or none passing are reported as such. Only the selected rule is scored on the TEST set, once.
Nothing is promoted: the candidate goes to model/candidate-labels/ with the rule, for a separate deploy decision.

    python flybook/worker/labels.py [--train 160 --val 60 --test 60 --clean 30] [--live-flies PATH]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import time

import numpy as np

from actions import ActionReader
from calibrate import MODEL, git_sha
from episode import AMOUNT, Episodes, features
from flybrain.reservoir import Readout
from patch import CHANNELS, WORD_OF, PatchRunner
from readout import BATCH, THRESHOLD_MIN_READS, clean_set, evaluate, verdict
from settings import PRESETS, breed, clean
from tick import load_model

RULES = {"R0": ("peak", 0.02), "R1": ("total", 0.05), "R2": ("total", 0.10), "R3": ("total", 0.25)}
PRECISION = 0.95                   # deployed variant D's threshold precision


def draw_settings(rng: np.random.Generator, live: list[dict]) -> dict:
    r = rng.random()
    if r < 0.2 or (r >= 0.8 and not live):
        return {}
    if r < 0.5:
        return PRESETS[int(rng.integers(len(PRESETS)))]["settings"]
    if r < 0.8:
        a, b = (PRESETS[int(i)]["settings"] for i in rng.integers(len(PRESETS), size=2))
        return breed(a, b, random.Random(int(rng.integers(2**31))))
    return live[int(rng.integers(len(live)))]


def patch_set(runner: PatchRunner, runs: int, seed0: int, live: list[dict], tag: str) -> dict:
    eps = runner.eps
    B, words = eps.brain.batch, eps.words
    rng = np.random.default_rng([20260914, seed0])
    out = {k: [] for k in ("X", "wing", "hit", "peak", "total")}
    t0 = time.perf_counter()
    for r in range(runs):
        n = int(rng.integers(3, B + 1))
        cx, cy = rng.uniform(0.3, 0.7, 2)
        pos = np.column_stack([np.clip(rng.normal(cx, 0.12, n), 0.05, 0.95),
                               np.clip(rng.normal(cy, 0.12, n), 0.05, 0.95), rng.uniform(0, 2 * np.pi, n)])
        pos = np.vstack([pos, np.tile([0.5, 0.5, 0.0], (B - n, 1))])
        settings = [draw_settings(rng, live) for _ in range(n)] + [{}] * (B - n)
        event = words[int(rng.integers(len(words)))]
        direct: list[tuple[str | None, float]] = [(None, 0.0)] * B
        if event != "nothing":
            direct[int(rng.integers(n))] = (event, 1.0)
        res = runner.run(direct, pos, ["p"] * n + [None] * (B - n), settings, seed=seed0 + r)
        out["X"].append(res["counts"][:n])
        out["wing"].append(res["wing"][:n])
        out["hit"] += [direct[i][0] or "" for i in range(n)]
        out["peak"].append(res["peak"][:n])
        out["total"].append(res["social"][:n] / (AMOUNT * eps.stim))    # share of a full direct stimulus
        if (r + 1) % 10 == 0 or r + 1 == runs:
            print(f"  {tag} {r + 1}/{runs}  {time.perf_counter() - t0:.0f}s", flush=True)
    return {"X": np.vstack(out["X"]), "wing": np.concatenate(out["wing"]), "hit": np.array(out["hit"]),
            "peak": np.vstack(out["peak"]), "total": np.vstack(out["total"])}


def label(d: dict, rule: tuple[str, float]) -> np.ndarray:
    kind, threshold = rule
    value = d["peak"] if kind == "peak" else d["total"]
    truth = []
    for i, h in enumerate(d["hit"]):
        if h:
            truth.append(h)
            continue
        reached = [c for c in range(len(CHANNELS)) if value[i, c] >= threshold]
        truth.append(WORD_OF[CHANNELS[max(reached, key=lambda c: d["total"][i, c])]] if reached else "nothing")
    return np.array(truth)


def thresholds_at(translator, words, X, truth, precision: float) -> dict[str, float]:
    probs = translator.predict(features(X))
    top, score = probs.argmax(1), probs.max(1)
    out = {}
    for k, w in enumerate(words):
        if w == "nothing":
            continue
        chosen = top == k
        s, right = score[chosen], truth[chosen] == w
        for t in np.unique(np.round(s, 4)):
            keep = s >= t
            if keep.sum() < THRESHOLD_MIN_READS:
                break
            if right[keep].mean() >= precision:
                out[w] = float(t)
                break
    return out


def checks(m: dict, truth: np.ndarray, translator, words, thresholds, X) -> dict:
    v = verdict(m)
    probs = translator.predict(features(X))
    top, score = probs.argmax(1), probs.max(1)
    said = np.array([words[k] if words[k] in thresholds and score[i] >= thresholds[words[k]] else "" for i, k in enumerate(top)])
    quiet = truth == "nothing"
    mate_p, mate_n = m["precision"].get("mate", [0.0, 0])
    v["M1 mate >= 85% precise"] = mate_n == 0 or mate_p >= 0.85
    v["M2 mate postable, >= 5 posts"] = "mate" in thresholds and mate_n >= 5
    v["M3 label nothing -> word <= 10%"] = bool((said[quiet] != "").mean() <= 0.10) if quiet.any() else True
    return {k: bool(x) for k, x in v.items()}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--train", type=int, default=160)
    p.add_argument("--val", type=int, default=60)
    p.add_argument("--test", type=int, default=60)
    p.add_argument("--clean", type=int, default=30)
    p.add_argument("--live-flies", help="JSON list of live flies (their senses/temperament/dials are sampled)")
    args = p.parse_args()

    live = []
    if args.live_flies:
        live = [clean({k: f.get(k) or {} for k in ("senses", "temperament", "dials")}) for f in json.load(open(args.live_flies))]
    translator0, vocab0 = load_model()
    eps = Episodes(batch=BATCH)
    reader = ActionReader(eps)
    reader.fit()
    runner = PatchRunner(eps, reader)
    words = eps.words
    cache = MODEL / "candidate-labels" / "episodes"
    cache.mkdir(parents=True, exist_ok=True)

    def cached(tag: str, runs: int, seed0: int) -> dict:
        path = cache / f"{tag}-{runs}.npz"
        if path.exists():
            print(f"  {tag}: reusing {path.name}", flush=True)
            return dict(np.load(path))
        d = patch_set(runner, runs, seed0, live, tag)
        np.savez(path, **d)
        return d

    test = cached("test", args.test, 910_000)
    val = cached("val", args.val, 710_000)
    train = cached("train", args.train, 510_000)
    clean_path = cache / f"clean-{args.clean}.npz"
    if clean_path.exists():
        c = np.load(clean_path)
        Xcl, ycl = c["X"], c["y"]
    else:
        Xcl, ycl = clean_set(eps, args.clean, 300_000)
        np.savez(clean_path, X=Xcl, y=ycl)

    report: dict = {"criteria": __doc__.split("Pass criteria")[1].split("    python")[0].strip(), "rules": {},
                    "flies": {"train": int(len(train["hit"])), "val": int(len(val["hit"])), "test": int(len(test["hit"]))}}
    live_thresholds = vocab0.get("thresholds", {})
    fitted = {}
    for name, rule in RULES.items():
        ytr, yva = label(train, rule), label(val, rule)
        tr = Readout.fit(features(np.vstack([Xcl, train["X"]])),
                         np.eye(len(words))[[words.index(t) for t in np.concatenate([ycl, ytr])]],
                         kind="ridge", components=(5, 20, 60), lambdas=(0.1, 1.0, 10.0), verbose=False)
        th = thresholds_at(tr, words, val["X"], yva, PRECISION)
        m = evaluate(tr, words, set(th), th, reader, val["X"], val["wing"], yva, val["hit"])
        ok = checks(m, yva, tr, words, th, val["X"])
        live_m = evaluate(translator0, words, set(live_thresholds), live_thresholds, reader, val["X"], val["wing"], yva, val["hit"])
        fitted[name] = (tr, th)
        share = {w: round(float((yva == w).mean()), 3) for w in ("nothing", "mate", "threat", "touch")}
        report["rules"][name] = {"rule": rule, "val_label_share": share, "val": m, "val_checks": ok, "passed_val": all(ok.values()),
                                 "live_model_on_these_labels": {k: live_m[k] for k in ("precision", "hallucination_rate", "post_rate")},
                                 "thresholds": th}
        print(f"\n{name} {rule}: labels {share}; posts {m['post_rate']:.0%}, nothing->word {m['hallucination_rate']:.0%}, "
              f"direct right {m['direct_right']:.0%}", flush=True)
        for w in m["postable"]:
            print(f"   {w:6s} precision {m['precision'][w][0]:.2f} ({m['precision'][w][1]})  recall {m['recall'][w]:.2f}", flush=True)
        print("   " + ", ".join(f"{'PASS' if x else 'FAIL'} {k.split()[0]}" for k, x in ok.items()), flush=True)
        print(f"   live model under these labels: mate {live_m['precision'].get('mate')}, nothing->word {live_m['hallucination_rate']:.0%}", flush=True)

    passing = [n for n in RULES if report["rules"][n]["passed_val"]]
    chosen = min(passing, key=lambda n: (RULES[n][0] != "total", RULES[n][1])) if passing else None
    report["selected"] = chosen
    if chosen:
        tr, th = fitted[chosen]
        yte = label(test, RULES[chosen])
        m = evaluate(tr, words, set(th), th, reader, test["X"], test["wing"], yte, test["hit"])
        ok = checks(m, yte, tr, words, th, test["X"])
        report["test"] = {"metrics": m, "checks": ok, "passed": all(ok.values())}
        print(f"\nSELECTED {chosen} on validation. TEST (once): posts {m['post_rate']:.0%}, nothing->word {m['hallucination_rate']:.0%}, "
              f"direct right {m['direct_right']:.0%}", flush=True)
        for w in m["postable"]:
            print(f"   {w:6s} precision {m['precision'][w][0]:.2f} ({m['precision'][w][1]})  recall {m['recall'][w]:.2f}", flush=True)
        print("   " + ", ".join(f"{'PASS' if x else 'FAIL'} {k}" for k, x in ok.items()), flush=True)
        out = MODEL / "candidate-labels"
        tr.save(out / "translator.npz")
        version = f"{dt.date.today():%Y%m%d}-{git_sha()}-labels-{chosen}"
        vocab = {**vocab0, "version": version, "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                 "thresholds": th, "label_rule": {"name": chosen, "kind": RULES[chosen][0], "threshold": RULES[chosen][1]},
                 "test": {"precision": {w: (m["precision"][w][0] if w in th else 0.0) for w in words},
                          "recall": {w: m["recall"].get(w, 0.0) for w in words},
                          "accuracy": m["direct_right"], "chance": 1 / len(words)}}
        vocab.pop("action_rest", None)
        (out / "vocab.json").write_text(json.dumps(vocab, indent=1))
    else:
        print("\nNo rule passed on validation; nothing scored on test.", flush=True)
    (MODEL / "candidate-labels" / "report.json").write_text(json.dumps(report, indent=1, default=str))


if __name__ == "__main__":
    main()
