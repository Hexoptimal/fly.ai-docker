"""Refit the post decoder's word thresholds (and maybe the translator) on flies like today's live flies.

Why (2026-09-15, live posts of the last 24 h): 'mate' is most word posts and nearly every hallucination, wind happened
often and was never posted, and real threats were sometimes missed. The deployed decoder (variant D, 2026-09-14) picked
its thresholds on patches whose settings were mostly presets; the live flies are now all tuned and many were born from
mating.

Episodes: like live ticks (labels.patch_set: 3-12 flies clustered in a patch, the event on one fly), with settings drawn
70% from the active live flies, 15% bred from two live flies, 15% standard or presets. New seeds, cached in
model/candidate-words/episodes.
Candidates (thresholds picked on validation at 95% precision with >= 5 reads, as variant D):
  A  the live translator, thresholds re-picked                                            labels: R0 (the live rule)
  B  translator refit on lone flies + training patches, thresholds re-picked              labels: R0
  C  as B, with labels.py's R1 rule (total neighbour input >= 5% of a direct stimulus)    labels: R1
BEFORE is the live translator with its live thresholds (R0), scored the same way for reference.

Pass criteria, fixed before running (on the test set, for the selected candidate):
  W1 every posted word with >= 5 posts is >= 85% precise
  W2 flies whose label is 'nothing' post a word <= 10% of the time
  W3 wind is postable and posted >= 5 times at >= 85% precision
  W4 directly stimulated flies are read right >= 70% of the time
  W5 flies hit directly by a threat are read 'threat' >= 90% of the time
  (readout.py's C6 is left out: it scores the standard-rest action reader, and live actions have been judged against each
  fly's own resting baseline since 2026-09-14; actions are not part of this refit)
Selection: on VALIDATION, the first of A, B, C that passes all five (the smallest change); if none passes, nothing is
scored on test. The selected candidate is scored on TEST once. Nothing is promoted: it goes to model/candidate-words/
for a separate deploy decision.

    python flybook/worker/wordfit.py --live-flies LIVE.json [--train 160 --val 60 --test 60 --clean 30]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random

import numpy as np

from actions import ActionReader
from calibrate import MODEL, git_sha
from episode import Episodes, features
from flybrain.reservoir import Readout
from labels import RULES, label, patch_set, thresholds_at
from patch import PatchRunner
from readout import BATCH, clean_set, evaluate
from settings import PRESETS, breed, clean
from tick import load_model

PRECISION = 0.95
OUT = MODEL / "candidate-words"


def draw_live(rng: np.random.Generator, live: list[dict]) -> dict:
    r = rng.random()
    if r < 0.70:
        return live[int(rng.integers(len(live)))]
    if r < 0.85:
        a, b = (live[int(i)] for i in rng.integers(len(live), size=2))
        return breed(a, b, random.Random(int(rng.integers(2**31))))
    if r < 0.925:
        return {}
    return PRESETS[int(rng.integers(len(PRESETS)))]["settings"]


def said_words(translator, words: list[str], thresholds: dict, X: np.ndarray) -> np.ndarray:
    probs = translator.predict(features(X))
    top, score = probs.argmax(1), probs.max(1)
    return np.array([words[k] if words[k] in thresholds and score[i] >= thresholds[words[k]] else "" for i, k in enumerate(top)])


def checks(m: dict, truth: np.ndarray, hit: np.ndarray, said: np.ndarray) -> dict:
    precision = m["precision"]
    wind_p, wind_n = precision.get("wind", [0.0, 0])
    quiet, threat = truth == "nothing", hit == "threat"
    return {
        "W1 posted words >= 85% precise": all(p >= 0.85 for p, n in precision.values() if n >= 5),
        "W2 label nothing -> word <= 10%": bool((said[quiet] != "").mean() <= 0.10) if quiet.any() else True,
        "W3 wind posted >= 5 at >= 85%": "wind" in m["postable"] and wind_n >= 5 and wind_p >= 0.85,
        "W4 direct reads right >= 70%": m["direct_right"] >= 0.70,
        "W5 direct threat read >= 90%": bool((said[threat] == "threat").mean() >= 0.90) if threat.any() else False,
    }


def show(tag: str, m: dict, ok: dict, said: np.ndarray, truth: np.ndarray) -> None:
    quiet = truth == "nothing"
    print(f"\n{tag}: {m['flies']} flies, posts a word {m['post_rate']:.0%}, label nothing -> word "
          f"{(said[quiet] != '').mean() if quiet.any() else 0:.0%}, direct right {m['direct_right']:.0%}", flush=True)
    for w in m["postable"]:
        p, n = m["precision"][w]
        print(f"   {w:6s} precision {p:.2f} ({n} posts)  recall {m['recall'][w]:.2f}  posted {m['posted_share'][w]:.0%} vs true {m['true_share'][w]:.0%}", flush=True)
    print("   " + ", ".join(f"{'PASS' if x else 'FAIL'} {k.split()[0]}" for k, x in ok.items()), flush=True)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--live-flies", required=True, help="JSON list of the active live flies (senses/temperament/dials)")
    p.add_argument("--train", type=int, default=160)
    p.add_argument("--val", type=int, default=60)
    p.add_argument("--test", type=int, default=60)
    p.add_argument("--clean", type=int, default=30)
    args = p.parse_args()

    live = [clean({k: f.get(k) or {} for k in ("senses", "temperament", "dials")}) for f in json.load(open(args.live_flies))]
    translator0, vocab0 = load_model()
    eps = Episodes(batch=BATCH)
    reader = ActionReader(eps)
    reader.fit()
    runner = PatchRunner(eps, reader)
    words = eps.words
    cache = OUT / "episodes"
    cache.mkdir(parents=True, exist_ok=True)

    def cached(tag: str, runs: int, seed0: int) -> dict:
        path = cache / f"{tag}-{runs}.npz"
        if path.exists():
            print(f"  {tag}: reusing {path.name}", flush=True)
            return dict(np.load(path))
        d = patch_set(runner, runs, seed0, live, tag, draw=draw_live)
        np.savez(path, **d)
        return d

    test = cached("test", args.test, 1_930_000)
    val = cached("val", args.val, 1_730_000)
    train = cached("train", args.train, 1_530_000)
    clean_path = cache / f"clean-{args.clean}.npz"
    if clean_path.exists():
        c = np.load(clean_path)
        Xcl, ycl = c["X"], c["y"]
    else:
        Xcl, ycl = clean_set(eps, args.clean, 1_330_000)
        np.savez(clean_path, X=Xcl, y=ycl)

    def fit(ytr: np.ndarray):
        return Readout.fit(features(np.vstack([Xcl, train["X"]])),
                           np.eye(len(words))[[words.index(t) for t in np.concatenate([ycl, ytr])]],
                           kind="ridge", components=(5, 20, 60), lambdas=(0.1, 1.0, 10.0), verbose=False)

    def score(translator, th: dict, d: dict, rule) -> tuple[dict, dict, np.ndarray, np.ndarray]:
        y = label(d, rule)
        m = evaluate(translator, words, set(th), th, reader, d["X"], d["wing"], y, d["hit"])
        said = said_words(translator, words, th, d["X"])
        return m, checks(m, y, d["hit"], said), said, y

    R0, R1 = RULES["R0"], RULES["R1"]
    report: dict = {"criteria": __doc__.split("Pass criteria")[1].split("Selection")[0].strip(), "live_flies": len(live),
                    "flies": {"train": int(len(train["hit"])), "val": int(len(val["hit"])), "test": int(len(test["hit"]))},
                    "before": {}, "candidates": {}}
    live_th = vocab0.get("thresholds", {})
    for tag, d in (("val", val), ("test", test)):
        m, ok, said, y = score(translator0, live_th, d, R0)
        report["before"][tag] = {"metrics": m, "checks": ok}
        show(f"BEFORE (live decoder) on {tag}", m, ok, said, y)

    candidates = {"A": (translator0, R0)}
    candidates["B"] = (fit(label(train, R0)), R0)
    candidates["C"] = (fit(label(train, R1)), R1)
    picked = {}
    for name, (tr, rule) in candidates.items():
        th = thresholds_at(tr, words, val["X"], label(val, rule), PRECISION)
        m, ok, said, y = score(tr, th, val, rule)
        picked[name] = th
        report["candidates"][name] = {"rule": rule, "thresholds": th, "val": m, "val_checks": ok, "passed_val": all(ok.values())}
        show(f"candidate {name} on val (thresholds {th})", m, ok, said, y)

    chosen = next((n for n in "ABC" if report["candidates"][n]["passed_val"]), None)
    report["selected"] = chosen
    if not chosen:
        print("\nNo candidate passed on validation; nothing scored on test.", flush=True)
    else:
        tr, rule = candidates[chosen]
        th = picked[chosen]
        m, ok, said, y = score(tr, th, test, rule)
        report["test"] = {"metrics": m, "checks": ok, "passed": all(ok.values())}
        show(f"SELECTED {chosen}, TEST (once)", m, ok, said, y)
        print("PASSED" if all(ok.values()) else "NOT PASSED", flush=True)
        OUT.mkdir(parents=True, exist_ok=True)
        tr.save(OUT / "translator.npz")
        version = f"{dt.date.today():%Y%m%d}-{git_sha()}-words-{chosen}"
        vocab = {**vocab0, "version": version, "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                 "thresholds": th,
                 "test": {"precision": {w: (m["precision"][w][0] if w in th else 0.0) for w in words},
                          "recall": {w: m["recall"].get(w, 0.0) for w in words},
                          "accuracy": m["direct_right"], "chance": 1 / len(words)}}
        vocab.pop("action_rest", None)
        vocab.pop("label_rule", None)
        if rule != R0:
            vocab["label_rule"] = {"name": "R1", "kind": rule[0], "threshold": rule[1]}
        (OUT / "vocab.json").write_text(json.dumps(vocab, indent=1))
    (OUT / "report.json").write_text(json.dumps(report, indent=1, default=str))


if __name__ == "__main__":
    main()
