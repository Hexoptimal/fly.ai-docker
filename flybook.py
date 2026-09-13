"""Flybook: a feed written by connectome flies, generated offline.

Every post comes from a real simulation step, never from a script:

  * Each round, flies are paired. One of each pair lives through something
    (nothing, a mate in view, a looming threat, a food smell) injected into its
    sensory neurons, exactly as in flytalk.py.
  * Its wing motor neurons "sing"; the partner hears that song live through its
    Johnston's-organ neurons (1-step delay), same ear encoder and gain as flytalk.
  * The post text is a translation of the song by a decoder trained on flytalk's
    recordings (<talk>/real.npz), shown with that decoder's measured precision for
    the word it chose. "What really happened" is the sender's actual context.
    A word is only posted if its held-out precision reaches --min-precision;
    the others are listed in the feed as not-yet-words.
  * Comments are the partner's reaction: descending-neuron groups compared with how
    the same groups fire in silence (<talk>/listen.npz). A comment only says something
    happened if it is more than 2 standard deviations away from silence.

The brain settings (step, sensory fix, refractory) are read from the flytalk run, so
the feed always matches the experiment it cites. Roles swap every round.

    python flytalk.py run --dt 0.002 --fix-sensory --refractory 0.004 --out talk-2ms
    python flybook.py --talk talk-2ms --rounds 40        # writes docs/assets/flybook.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import time
from pathlib import Path

import numpy as np

from flybrain.reservoir import Readout
from flytalk import (BEHAVIOUR, BIN_S, EAR_CAP, NAMES, ROOT, Counter, context_injector, decode, describe, ear_cells,
                     envelope, make_brain, reaction_quantities, silence_reference, song_features, wing_groups, windows)

# Classic wild-type lab strains. Every fly here is the same male connectome with its own noise.
FLY_NAMES = ["Canton-S", "Oregon-R", "Berlin-K", "Dahomey", "Hikone", "Lausanne",
             "Samarkand", "Tai-18", "Florida-9", "Swedish-C", "w1118", "Iso-31"]


def load_meta(real) -> dict:
    return {"dt": float(real["dt"]) if "dt" in real.files else 0.020,
            "fix_sensory": bool(real["fix_sensory"]) if "fix_sensory" in real.files else False,
            "refractory": float(real["refractory"]) if "refractory" in real.files else 0.0}


def train_translator(real, dt_: float) -> tuple[Readout, list[float], list[float], float]:
    X = song_features(real["songs"], dt_)
    y = real["labels"]
    conf = decode(X, y, len(NAMES))
    precision = [float(conf[c, c] / max(conf[:, c].sum(), 1)) for c in range(len(NAMES))]
    recall = [float(conf[c, c] / max(conf[c].sum(), 1)) for c in range(len(NAMES))]
    accuracy = float(np.trace(conf) / conf.sum())
    translator = Readout.fit(X, np.eye(len(NAMES))[y], kind="ridge", components=(5, 20, 60), lambdas=(0.1, 1.0, 10.0))
    return translator, precision, recall, accuracy


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--talk", default="talk-2ms", help="flytalk results folder to learn from")
    p.add_argument("--rounds", type=int, default=40)
    p.add_argument("--device", default="auto")
    p.add_argument("--seed", type=int, default=11)
    p.add_argument("--min-precision", type=float, default=0.35, help="post a word only if held-out precision reaches this")
    p.add_argument("--feed", default="docs/assets/flybook.json")
    args = p.parse_args()

    talk = ROOT / args.talk
    real, heard = np.load(talk / "real.npz"), np.load(talk / "listen.npz")
    meta = load_meta(real)
    step = meta["dt"]
    W, S = windows(step)
    per = max(1, int(round(BIN_S / step)))
    rest, gain = float(real["rest"]), float(real["gain"])
    translator, precision, recall, accuracy = train_translator(real, step)
    words = [NAMES[c] for c in range(len(NAMES)) if NAMES[c] != "baseline" and precision[c] >= args.min_precision]
    print(f"{meta}; translator accuracy {accuracy:.2f}; precision " +
          ", ".join(f"{w} {q:.2f}" for w, q in zip(NAMES, precision)) + f"; posting: {words}")

    B = len(FLY_NAMES)
    brain = make_brain(meta, B, seed=args.seed, device=args.device)
    rng = np.random.default_rng(args.seed)
    inject_ctx = context_injector(brain)
    ear = ear_cells(brain)
    wing = wing_groups(brain)
    types = [str(t) for t in np.unique(brain.cell_type)]
    groups = {g: brain.groups[g] for g in BEHAVIOUR}
    groups["wing_L"], groups["wing_R"] = wing["L"], wing["R"]
    groups["courtship"] = brain.cells([t for t in types if t.startswith(("pC1", "P1_"))])
    groups["song_cmd"] = brain.cells(["pIP10", "dPR1"] + [t for t in types if t.startswith("TN1")])
    groups["food_pn"] = brain.cells(["DM1_lPN", "DM2_lPN"])
    count = Counter(brain, groups)
    col = {name: i for i, name in enumerate(count.names)}
    silence = silence_reference(heard)

    half = B // 2
    posts, t0 = [], time.perf_counter()
    for r in range(args.rounds):
        order = rng.permutation(B)
        speakers, listeners = order[:half], order[half:]
        ctx = np.full(B, -1)
        ctx[speakers] = rng.integers(0, len(NAMES), half)
        brain.reset(args.seed * 10_000 + r)
        song = np.zeros((B, W + S, 2), np.float32)
        window = np.zeros((B, len(count.names)), np.float32)       # spikes/s over the song window
        ear_amount = np.zeros(B, np.float32)
        for s in range(W + S):
            inject = (inject_ctx(ctx) if s >= W else []) + [(ear, ear_amount.copy())]
            c = count(brain.step(inject=inject))
            song[:, s] = c[:, [col["wing_L"], col["wing_R"]]]
            loud = np.maximum(song[:, s].sum(-1) - rest, 0.0)
            ear_amount[:] = 0.0
            ear_amount[listeners] = np.minimum(gain * loud[speakers], EAR_CAP)   # partner's song, next step
            if s >= W:
                window += c / (S * step)
        probs = translator.predict(song_features(song[speakers], step))
        env = envelope(song[speakers], step).sum(-1)                 # 20 ms bins, both wings
        for i, (a, b) in enumerate(zip(speakers, listeners)):
            word = NAMES[int(np.argmax(probs[i]))]
            if word not in words:
                continue                                              # nothing it can say yet: no post
            q = reaction_quantities(window[b], col)
            z = {k: (float(v) - silence[k][0]) / silence[k][1] for k, v in q.items()}
            posts.append({
                "id": f"r{r}-{a}", "round": r, "t": round(r * (W + S) * step, 1),
                "fly": int(a), "word": word, "confidence": round(precision[NAMES.index(word)], 2),
                "truth": NAMES[ctx[a]],
                "envelope": [int(x) for x in env[i]],
                "neurons": {"wing_mn": round(float(window[a, col["wing_L"]] + window[a, col["wing_R"]]), 1),
                            "courtship": round(float(window[a, col["courtship"]]), 1),
                            "song_cmd": round(float(window[a, col["song_cmd"]]), 1),
                            "escape": round(float(window[a, col["escape_L"]] + window[a, col["escape_R"]]), 1),
                            "food_pn": round(float(window[a, col["food_pn"]]), 1)},
                "comments": [{"fly": int(b), "reaction": describe(z), "z": {k: round(v, 1) for k, v in z.items()}}],
            })
        if r == 0 or (r + 1) % 10 == 0:
            print(f"  round {r + 1}/{args.rounds}  {len(posts)} posts  {(time.perf_counter() - t0) / (r + 1):.1f} s/round", flush=True)

    feed = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "config": meta, "talk": args.talk,
        "rounds": args.rounds, "seconds_per_round": round((W + S) * step, 3),
        "rest": rest * per,                                          # resting wing spikes per 20 ms bin
        "flies": [{"id": i, "name": n} for i, n in enumerate(FLY_NAMES)],
        "translator": {"precision": dict(zip(NAMES, precision)), "recall": dict(zip(NAMES, recall)),
                       "accuracy": accuracy, "posted_words": words,
                       "not_yet_words": [w for w in NAMES if w != "baseline" and w not in words]},
        "posts": posts,
    }
    out = ROOT / args.feed
    out.write_text(json.dumps(feed, separators=(",", ":")))
    true = sum(p["truth"] == p["word"] for p in posts)
    print(f"wrote {len(posts)} posts to {out} ({out.stat().st_size // 1024} KB); {true} true")


if __name__ == "__main__":
    main()
