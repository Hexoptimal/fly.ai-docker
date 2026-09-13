"""Duels: two flies face the same slowly growing looming threat, side by side, in one coupled run.

Kinds, picked at random per duel so no single setting wins every time:
  quickdraw  the first fly whose giant fibre bursts wins (reflexes)
  stare      the fly that holds out longest wins (nerve); never jumping beats jumping
The same step, neither jumping in a quickdraw, or both holding in a stare, is a draw.
The flies sit 0.1 apart facing each other, so one fly's jump is also looming input for the other
(patch.py). The threat grows linearly from nothing to a full stimulus over the 1 s window.
Elo: K = 32, every fly starts at 1000. Nothing here decides who jumps; the brains do.
"""
from __future__ import annotations

import datetime as dt
import random

import numpy as np

from episode import DT
from patch import FRAME_EVERY, PatchRunner

K = 32
KINDS = ("quickdraw", "stare")


def outcome(kind: str, a_step: int | None, b_step: int | None) -> float:
    """1 = a wins, 0 = b wins, 0.5 = draw. Steps are the first escape burst (None = never jumped)."""
    if a_step == b_step:
        return 0.5
    if kind == "quickdraw":
        if a_step is None:
            return 0.0
        if b_step is None:
            return 1.0
        return 1.0 if a_step < b_step else 0.0
    if a_step is None:
        return 1.0
    if b_step is None:
        return 0.0
    return 1.0 if a_step > b_step else 0.0


def elo_delta(a_elo: int, b_elo: int, score: float) -> int:
    expected = 1 / (1 + 10 ** ((b_elo - a_elo) / 400))
    return round(K * (score - expected))


def matchmake(flies: list[dict], count: int, rng: np.random.Generator) -> list[tuple[dict, dict]]:
    """Up to `count` pairs of flies with neighbouring ratings, no fly twice."""
    pool = sorted(flies, key=lambda f: (f.get("elo") or 1000, f["id"]))
    used: set[str] = set()
    pairs = []
    for _ in range(count * 4):
        if len(pairs) >= count or len(pool) - len(used) < 2:
            break
        i = int(rng.integers(len(pool)))
        j = i + (1 if rng.random() < 0.5 else -1)
        if not 0 <= j < len(pool):
            continue
        a, b = pool[i], pool[j]
        if a["id"] in used or b["id"] in used:
            continue
        used.update((a["id"], b["id"]))
        pairs.append((a, b))
    return pairs


def run_duels(runner: PatchRunner, duels: list[dict], flies: dict[str, dict], seed: int) -> list[dict]:
    """Fight pending duels (rows from the duels table) in brain batches. Returns update rows:
    {id, status, winner, a_step, b_step, a_elo, b_elo, delta, replay} (ms for steps)."""
    B = runner.eps.brain.batch
    out = []
    ready = []
    for d in duels:
        a, b = flies.get(d["a_fly"]), flies.get(d["b_fly"])
        if not a or not b or a.get("active") is False or b.get("active") is False:
            out.append({"id": d["id"], "status": "cancelled"})
        else:
            ready.append((d, a, b))
    for start in range(0, len(ready), B // 2):
        chunk = ready[start:start + B // 2]
        pad = B - 2 * len(chunk)
        pos, settings, patch_of, direct = [], [], [], []
        for k, (d, a, b) in enumerate(chunk):
            pos += [[0.45, 0.5, 0.0], [0.55, 0.5, np.pi]]
            settings += [{g: a.get(g) or {} for g in ("senses", "temperament", "dials")},
                         {g: b.get(g) or {} for g in ("senses", "temperament", "dials")}]
            patch_of += [f"duel-{d['id']}"] * 2
            direct += [("threat", 1.0), ("threat", 1.0)]
        pos += [[0.5, 0.5, 0.0]] * pad
        settings += [{}] * pad
        patch_of += [None] * pad
        direct += [(None, 0.0)] * pad
        res = runner.run(direct, np.array(pos), patch_of, settings, seed=seed + start, ramp=True)
        for k, (d, a, b) in enumerate(chunk):
            ia, ib = 2 * k, 2 * k + 1
            steps = [res["first_hop"][ia], res["first_hop"][ib]]
            score = outcome(d["kind"], *steps)
            a_elo, b_elo = a.get("elo") or 1000, b.get("elo") or 1000
            delta = elo_delta(a_elo, b_elo, score)
            winner = None if score == 0.5 else (a["id"] if score == 1.0 else b["id"])
            out.append({
                "id": d["id"], "status": "done", "winner": winner,
                "a_step": None if steps[0] is None else int(steps[0] * DT * 1000),
                "b_step": None if steps[1] is None else int(steps[1] * DT * 1000),
                "a_elo": a_elo, "b_elo": b_elo, "delta": delta,
                "done_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "replay": {"flies": [a["id"], b["id"]], "frames": [[fr[ia], fr[ib]] for fr in res["frames"]],
                           "links": [{"from": [a["id"], b["id"]][l["from"] - ia], "to": [a["id"], b["id"]][l["to"] - ia],
                                      "channel": l["channel"], "step": l["step"]}
                                     for l in res["links"] if l["from"] in (ia, ib) and l["to"] in (ia, ib)],
                           "event": {"stimulus": "threat", "x": 0.5, "y": 0.5, "poke_id": None, "fly_id": None},
                           "frame_ms": int(FRAME_EVERY * DT * 1000)},
            })
    return out


def new_kind() -> str:
    return random.choice(KINDS)
