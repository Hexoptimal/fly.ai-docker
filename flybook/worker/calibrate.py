"""Train the Flybook translator: descending-neuron activity -> which sense was stimulated.

    python flybook/worker/calibrate.py --train 48 --test 24

Train and test episodes use different seeds, so the precision and recall written to
model/vocab.json are held out: the fit never saw those episodes. The worker posts a word
with that word's test precision as its confidence.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import time

import numpy as np

from episode import CONFIG, HERE, ROOT, Episodes, features
from flybrain.reservoir import Readout

MODEL = HERE / "model"


def git_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:
        return "unknown"


def collect(eps: Episodes, trials: int, seed0: int, tag: str) -> tuple[np.ndarray, np.ndarray]:
    W, per = eps.words, eps.brain.batch // len(eps.words)
    X, y, t0 = [], [], time.perf_counter()
    rounds = -(-trials // per)
    for r in range(rounds):
        stim = [w for w in W for _ in range(per)]
        counts, _ = eps.run(stim, seed=seed0 + r)
        X.append(counts)
        y += [W.index(s) for s in stim]
        print(f"  {tag} {r + 1}/{rounds}  {time.perf_counter() - t0:.0f}s", flush=True)
    return np.vstack(X), np.array(y)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--train", type=int, default=48, help="training episodes per word")
    p.add_argument("--test", type=int, default=24, help="held-out episodes per word (fresh seeds)")
    p.add_argument("--per-batch", type=int, default=4, help="flies per word in each batched episode")
    args = p.parse_args()

    eps = Episodes(batch=args.per_batch * len(CONFIG["senses"]))
    W, k = eps.words, len(eps.words)
    Xtr, ytr = collect(eps, args.train, 10_000, "train")
    Xte, yte = collect(eps, args.test, 90_000, "test")

    translator = Readout.fit(features(Xtr), np.eye(k)[ytr], kind="ridge", components=(5, 20, 60),
                             lambdas=(0.1, 1.0, 10.0), verbose=True)
    pred = np.argmax(translator.predict(features(Xte)), axis=1)
    conf = np.zeros((k, k), int)
    np.add.at(conf, (yte, pred), 1)
    precision = {w: float(conf[c, c] / max(conf[:, c].sum(), 1)) for c, w in enumerate(W)}
    recall = {w: float(conf[c, c] / max(conf[c].sum(), 1)) for c, w in enumerate(W)}

    rest = eps.type_counts(Xtr[ytr == W.index("nothing")])
    MODEL.mkdir(exist_ok=True)
    translator.save(MODEL / "translator.npz")
    version = f"{dt.date.today():%Y%m%d}-{git_sha()}"
    vocab = {
        "version": version, "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "config": CONFIG, "words": W, "train_per_word": int((ytr == 0).sum()), "test_per_word": int((yte == 0).sum()),
        "test": {"precision": precision, "recall": recall, "accuracy": float(np.trace(conf) / conf.sum()),
                 "chance": 1 / k, "confusion": conf.tolist()},
        "rest": {"types": eps.types.tolist(), "mean": rest.mean(0).round(3).tolist(), "sd": rest.std(0).round(3).tolist()},
    }
    (MODEL / "vocab.json").write_text(json.dumps(vocab, indent=1))
    print(f"translator {version}: held-out accuracy {vocab['test']['accuracy']:.2f} (chance {1 / k:.2f})")
    for w in W:
        print(f"  {w:8s} precision {precision[w]:.2f}  recall {recall[w]:.2f}")


if __name__ == "__main__":
    main()
