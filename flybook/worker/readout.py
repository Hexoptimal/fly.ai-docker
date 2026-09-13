"""Measure and fix the Flybook readout under live conditions: flies in a patch, with neighbours and owner settings.

Why: 300 live posts (2026-09-13) said cVA 121 times when cVA really happened 11 times, and 'buzzed its wings'
was on 83% of posts. The translator (calibrate.py) and the action reader's resting baseline (actions.fit) were
both calibrated on lone standard flies, but live flies sit next to neighbours and carry their owners' settings.

What this does, on episodes built like live ticks (patch.PatchRunner: 3-12 flies clustered in one patch, settings
drawn from settings.PRESETS, the event on one fly, truth labelled exactly as tick.run_tick labels it):
  BEFORE  the current translator, postable words and resting baseline, scored on a held-out test set
  AFTER   the translator refit on clean episodes plus patch episodes; a per-word confidence threshold picked on a
          separate validation set (the lowest score at which that word is >= 85% precise with >= 5 reads; a word
          with no such score is not posted); the action baseline refit on patch flies that had nothing happen to
          them. Scored on the same held-out test set.

Pass criteria, fixed before the first run (all must hold on the test set, AFTER):
  C1  cVA's share of posted words is at most 2x cVA's share of what really happened
  C2  every postable word that gets posted is >= 80% precise
  C3  at least 4 of the 6 words stay postable (so it cannot pass by going quiet)
  C4  flies that had nothing happen post a word at most 15% of the time
  C5  flies stimulated directly are read right at least 60% of the time
  C6  'buzzed' shows on at most 30% of flies that had nothing happen, and on at least 80% of flies hit by a threat
The candidate always goes to model/candidate/; only a pass replaces model/translator.npz and model/vocab.json
(the old ones move to model/previous/).

    python flybook/worker/readout.py [--train 160 --val 60 --test 60 --clean 30]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import time

import numpy as np

from actions import ACTIONS, ActionReader
from calibrate import MODEL, git_sha
from episode import Episodes, features
from flybrain.reservoir import Readout
from patch import WORD_OF, PatchRunner
from settings import PRESETS
from tick import load_model

BATCH = 12
THRESHOLD_PRECISION, THRESHOLD_MIN_READS = 0.85, 5


def patch_set(runner: PatchRunner, runs: int, seed0: int, rng: np.random.Generator, tag: str):
    """Live-like patches. Returns DN counts, wing rates, truth and the directly hit word ('' if none) per fly."""
    eps = runner.eps
    B, words = eps.brain.batch, eps.words
    X, wing, truth, hit = [], [], [], []
    t0 = time.perf_counter()
    for r in range(runs):
        n = int(rng.integers(3, B + 1))
        cx, cy = rng.uniform(0.3, 0.7, 2)
        pos = np.column_stack([np.clip(rng.normal(cx, 0.12, n), 0.05, 0.95),
                               np.clip(rng.normal(cy, 0.12, n), 0.05, 0.95), rng.uniform(0, 2 * np.pi, n)])
        pos = np.vstack([pos, np.tile([0.5, 0.5, 0.0], (B - n, 1))])
        settings = [{} if rng.random() < 0.35 else PRESETS[int(rng.integers(len(PRESETS)))]["settings"] for _ in range(n)]
        settings += [{}] * (B - n)
        event = words[int(rng.integers(len(words)))]
        direct: list[tuple[str | None, float]] = [(None, 0.0)] * B
        if event != "nothing":
            direct[int(rng.integers(n))] = (event, 1.0)
        res = runner.run(direct, pos, ["p"] * n + [None] * (B - n), settings, seed=seed0 + r)
        for i in range(n):
            h = direct[i][0]
            cause = None if h else runner.cause(res, i)
            truth.append(h or (WORD_OF.get(cause["channel"], "nothing") if cause else "nothing"))
            hit.append(h or "")
        X.append(res["counts"][:n])
        wing.append(res["wing"][:n])
        if (r + 1) % 10 == 0 or r + 1 == runs:
            print(f"  {tag} {r + 1}/{runs}  {time.perf_counter() - t0:.0f}s", flush=True)
    return np.vstack(X), np.concatenate(wing), np.array(truth), np.array(hit)


def clean_set(eps: Episodes, runs: int, seed0: int):
    """Lone standard flies, one word each, as calibrate.py trains on (words cycle across the batch)."""
    B, words = eps.brain.batch, eps.words
    X, y = [], []
    for r in range(runs):
        stim = [words[(r * B + i) % len(words)] for i in range(B)]
        counts, _ = eps.run(stim, seed=seed0 + r)
        X.append(counts)
        y += stim
    return np.vstack(X), np.array(y)


def evaluate(translator, words, postable, thresholds, reader, X, wing, truth, hit) -> dict:
    probs = translator.predict(features(X))
    top, score = probs.argmax(1), probs.max(1)
    said = np.array([words[k] if words[k] in postable and score[i] >= thresholds.get(words[k], -np.inf) else ""
                     for i, k in enumerate(top)])
    buzzed = np.array([any(a["key"] == "buzzed" for a in acts) for acts in reader.read(X, wing)])
    posted, nothing, direct = said != "", truth == "nothing", hit != ""
    real = sorted(w for w in postable if w != "nothing")
    return {
        "flies": int(len(truth)),
        "postable": real,
        "precision": {w: [round(float(((said == w) & (truth == w)).sum() / max((said == w).sum(), 1)), 3), int((said == w).sum())]
                      for w in real},
        "recall": {w: round(float(((said == w) & (truth == w)).sum() / max((truth == w).sum(), 1)), 3) for w in real},
        "posted_share": {w: round(float((said == w).sum() / max(posted.sum(), 1)), 3) for w in real},
        "true_share": {w: round(float((truth == w).mean()), 3) for w in words},
        "cva_ratio": round(float(((said == "cva").sum() / max(posted.sum(), 1)) / max((truth == "cva").mean(), 1e-9)), 2),
        "hallucination_rate": round(float(posted[nothing].mean()), 3) if nothing.any() else 0.0,
        "direct_right": round(float((said[direct] == hit[direct]).mean()), 3) if direct.any() else 0.0,
        "buzz_rest": round(float(buzzed[nothing].mean()), 3) if nothing.any() else 0.0,
        "buzz_threat": round(float(buzzed[hit == "threat"].mean()), 3) if (hit == "threat").any() else 0.0,
        "post_rate": round(float(posted.mean()), 3),
    }


def verdict(m: dict) -> dict:
    return {
        "C1 cVA not over-posted": m["cva_ratio"] <= 2.0,
        "C2 posted words >= 80% precise": all(p >= 0.8 for p, n in m["precision"].values() if n > 0),
        "C3 >= 4 words postable": len(m["postable"]) >= 4,
        "C4 nothing -> word <= 15%": m["hallucination_rate"] <= 0.15,
        "C5 direct reads right >= 60%": m["direct_right"] >= 0.60,
        "C6 buzzed rest <= 30%, threat >= 80%": m["buzz_rest"] <= 0.30 and m["buzz_threat"] >= 0.80,
    }


def pick_thresholds(translator, words, X, truth) -> dict[str, float]:
    probs = translator.predict(features(X))
    top, score = probs.argmax(1), probs.max(1)
    out = {}
    for k, w in enumerate(words):
        if w == "nothing":
            continue
        chosen = top == k
        s, right = score[chosen], truth[chosen] == w
        for t in np.unique(np.round(s, 4)):              # ascending
            keep = s >= t
            if keep.sum() < THRESHOLD_MIN_READS:
                break
            if right[keep].mean() >= THRESHOLD_PRECISION:
                out[w] = float(t)
                break
    return out


def show(tag: str, m: dict, v: dict | None = None) -> None:
    print(f"\n{tag}: {m['flies']} flies, posts a word {m['post_rate']:.0%}; cVA ratio {m['cva_ratio']}, "
          f"nothing->word {m['hallucination_rate']:.0%}, direct right {m['direct_right']:.0%}, "
          f"buzzed rest {m['buzz_rest']:.0%} / threat {m['buzz_threat']:.0%}", flush=True)
    for w in m["postable"]:
        p, n = m["precision"][w]
        print(f"  {w:6s} precision {p:.2f} ({n} posts)  recall {m['recall'][w]:.2f}  posted {m['posted_share'][w]:.0%} vs true {m['true_share'][w]:.0%}")
    if v:
        for name, ok in v.items():
            print(f"  {'PASS' if ok else 'FAIL'}  {name}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--train", type=int, default=160, help="patch runs to fit on")
    p.add_argument("--val", type=int, default=60, help="patch runs to pick thresholds on")
    p.add_argument("--test", type=int, default=60, help="held-out patch runs to score on")
    p.add_argument("--clean", type=int, default=30, help="lone-fly runs added to the fit")
    p.add_argument("--no-promote", action="store_true", help="never replace the live model, even on a pass (smoke tests)")
    args = p.parse_args()

    translator0, vocab0 = load_model()
    eps = Episodes(batch=BATCH)
    reader0 = ActionReader(eps)
    reader0.fit()
    runner = PatchRunner(eps, reader0)
    words = eps.words
    rng = np.random.default_rng(20260914)

    print("building episodes", flush=True)
    cache = MODEL / "candidate" / "episodes"
    cache.mkdir(parents=True, exist_ok=True)

    def cached(tag: str, runs: int, seed0: int):
        """Each finished set is saved, so a killed run resumes where it stopped. Each set has its own RNG
        (seeded from its tag) so a resumed set is the same as an uninterrupted one."""
        path = cache / f"{tag}-{runs}.npz"
        if path.exists():
            d = np.load(path)
            print(f"  {tag}: reusing {path.name} ({len(d['truth'])} flies)", flush=True)
            return d["X"], d["wing"], d["truth"], d["hit"]
        out = patch_set(runner, runs, seed0, np.random.default_rng([20260914, seed0]), tag)
        np.savez(path, X=out[0], wing=out[1], truth=out[2], hit=out[3])
        return out

    Xte, wte, tte, hte = cached("test", args.test, 900_000)
    Xva, wva, tva, hva = cached("val", args.val, 700_000)
    Xtr, wtr, ttr, htr = cached("train", args.train, 500_000)
    clean_path = cache / f"clean-{args.clean}.npz"
    if clean_path.exists():
        d = np.load(clean_path)
        Xcl, ycl = d["X"], d["y"]
    else:
        Xcl, ycl = clean_set(eps, args.clean, 300_000)
        np.savez(clean_path, X=Xcl, y=ycl)

    postable0 = {w for w, q in vocab0["test"]["precision"].items() if w != "nothing" and q >= 0.6}
    before = evaluate(translator0, words, postable0, {}, reader0, Xte, wte, tte, hte)
    show("BEFORE (live model)", before, verdict(before))

    X = np.vstack([Xcl, Xtr])
    y = np.concatenate([ycl, ttr])
    translator = Readout.fit(features(X), np.eye(len(words))[[words.index(t) for t in y]], kind="ridge",
                             components=(5, 20, 60), lambdas=(0.1, 1.0, 10.0), verbose=False)
    thresholds = pick_thresholds(translator, words, Xva, tva)
    reader = ActionReader(eps)
    quiet = ttr == "nothing"
    rest = reader.fit_values(reader.values(Xtr[quiet], wtr[quiet]))
    after = evaluate(translator, words, set(thresholds), thresholds, reader, Xte, wte, tte, hte)
    checks = verdict(after)
    show("AFTER (candidate)", after, checks)
    passed = all(checks.values())

    version = f"{dt.date.today():%Y%m%d}-{git_sha()}-patch"
    vocab = {**vocab0,
             "version": version, "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
             "test": {"precision": {w: (after["precision"][w][0] if w in thresholds else 0.0) for w in words},
                      "recall": {w: after["recall"].get(w, 0.0) for w in words},
                      "accuracy": after["direct_right"], "chance": 1 / len(words)},
             "thresholds": thresholds, "action_rest": rest,
             "patch_eval": {"criteria": __doc__.split("Pass criteria")[1].split("The candidate")[0].strip(),
                            "before": before, "after": after, "checks": checks, "passed": passed,
                            "runs": {"train": args.train, "val": args.val, "test": args.test, "clean": args.clean}}}
    cand = MODEL / "candidate"
    cand.mkdir(exist_ok=True)
    translator.save(cand / "translator.npz")
    (cand / "vocab.json").write_text(json.dumps(vocab, indent=1))
    print(f"\ncandidate {version} written to {cand}; thresholds {thresholds}", flush=True)
    if not passed or args.no_promote:
        print(("PASSED but --no-promote" if passed else "NOT PASSED") + ": the live model is unchanged", flush=True)
        return
    prev = MODEL / "previous"
    prev.mkdir(exist_ok=True)
    for name in ("translator.npz", "vocab.json"):
        shutil.copy2(MODEL / name, prev / name)
        shutil.copy2(cand / name, MODEL / name)
    print("PASSED: model/translator.npz and model/vocab.json replaced (old ones in model/previous/)", flush=True)


if __name__ == "__main__":
    main()
