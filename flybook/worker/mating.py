"""Automatic mating between flies of different owners.

Two ways a pair forms, both only between active flies whose owners are different people:
  brain    a fly's translator reads 'mate' this tick and a fly from another owner is within REACH of it
           in the same patch (the nearest one)
  matched  the worker pairs flies at random, AUTO_PER_TICK pairs per full tick, like matchmade duels

The child's settings mix and mutate its parents' (settings.breed), its owner is a coin flip between the
parents' owners, it hatches between its parents in one of their patches, and it does not count toward
its owner's per-wallet cap (auto_born). Nothing is posted as text.

Limits, because born flies are uncapped: a fly mates at most once per COOLDOWN, a fly born from mating
waits one COOLDOWN before it can mate, and nobody mates while POPULATION_CAP or more flies are active.
"""
from __future__ import annotations

import datetime as dt
import random
import re

import numpy as np

import settings as fly_settings
from patch import REACH

COOLDOWN = dt.timedelta(hours=24)
AUTO_PER_TICK = 1
POPULATION_CAP = 150
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$")   # same rule as the API


def _time(value) -> dt.datetime | None:
    if not value:
        return None
    return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def eligible(flies: list[dict], now: dt.datetime) -> list[dict]:
    """Owned flies rested enough to mate, and babies from mating old enough (pass active flies only)."""
    out = []
    for f in flies:
        if not f.get("owner"):
            continue
        born, mated = _time(f.get("created_at")), _time(f.get("last_mated_at"))
        if f.get("auto_born") and born and now - born < COOLDOWN:
            continue
        if mated and now - mated < COOLDOWN:
            continue
        out.append(f)
    return out


def brain_pairs(readers: list[str], pool: dict[str, dict]) -> list[tuple[dict, dict]]:
    """Each fly that read 'mate' pairs with the nearest eligible fly of another owner within REACH in its patch."""
    used: set[str] = set()
    pairs = []
    for rid in readers:
        a = pool.get(rid)
        if not a or rid in used or a.get("x") is None:
            continue
        best, best_d = None, REACH
        for b in pool.values():
            if b["id"] in used or b["id"] == rid or b["owner"] == a["owner"] or b["patch_id"] != a["patch_id"] or b.get("x") is None:
                continue
            d = float(np.hypot(b["x"] - a["x"], b["y"] - a["y"]))
            if d <= best_d:
                best, best_d = b, d
        if best:
            used.update((rid, best["id"]))
            pairs.append((a, best))
    return pairs


def matched_pairs(pool: list[dict], count: int, rng: np.random.Generator) -> list[tuple[dict, dict]]:
    """Up to `count` random pairs with different owners, no fly twice."""
    order = [pool[i] for i in rng.permutation(len(pool))]
    used: set[str] = set()
    pairs = []
    for a in order:
        if len(pairs) >= count:
            break
        if a["id"] in used:
            continue
        b = next((b for b in order if b["id"] not in used and b["id"] != a["id"] and b["owner"] != a["owner"]), None)
        if b:
            used.update((a["id"], b["id"]))
            pairs.append((a, b))
    return pairs


def child_name(a: str, b: str, taken: set[str], rng: random.Random) -> str:
    """The front of one parent's name and the back of the other's, made unique."""
    first, second = (a, b) if rng.random() < 0.5 else (b, a)
    base = (first[: max(1, (len(first) + 1) // 2)] + second[len(second) // 2:]).strip()
    base = re.sub(r"[^A-Za-z0-9 ._-]", "", base).strip(" ._-")[:32] or "Fly"
    if not base[0].isalnum():
        base = "F" + base
    for suffix in ["", " Jr", *[f" {n}" for n in range(2, 1000)]]:
        name = (base + suffix)[:40]
        if NAME.match(name) and name not in taken:
            return name
    return f"Fly {rng.randrange(10**6)}"


def child_color(a: str, b: str, rng: random.Random) -> str:
    """The parents' colours averaged, with a little drift."""
    def rgb(c: str) -> list[int]:
        c = c if re.fullmatch(r"#[0-9a-fA-F]{6}", c or "") else "#e0342c"
        return [int(c[i:i + 2], 16) for i in (1, 3, 5)]
    mixed = [min(255, max(0, (x + y) // 2 + rng.randint(-24, 24))) for x, y in zip(rgb(a), rgb(b))]
    return "#" + "".join(f"{v:02x}" for v in mixed)


def make_child(a: dict, b: dict, taken: set[str], rng: random.Random) -> dict:
    """The new fly's row."""
    home = a if rng.random() < 0.5 else b
    xs = [f["x"] for f in (a, b) if f.get("x") is not None and f["patch_id"] == home["patch_id"]]
    ys = [f["y"] for f in (a, b) if f.get("y") is not None and f["patch_id"] == home["patch_id"]]
    x = sum(xs) / len(xs) if xs else rng.uniform(0.3, 0.7)
    y = sum(ys) / len(ys) if ys else rng.uniform(0.3, 0.7)
    return {
        "owner": rng.choice([a["owner"], b["owner"]]),
        "name": child_name(a["name"], b["name"], taken, rng),
        "color": child_color(a.get("color", ""), b.get("color", ""), rng),
        "patch_id": home["patch_id"], "seed": rng.randrange(2**31),
        "x": round(min(0.95, max(0.05, x + rng.uniform(-0.04, 0.04))), 3),
        "y": round(min(0.95, max(0.05, y + rng.uniform(-0.04, 0.04))), 3),
        "heading": round(rng.uniform(0, 6.283), 2),
        "parents": [a["id"], b["id"]],
        "generation": max(a.get("generation") or 1, b.get("generation") or 1) + 1,
        "auto_born": True,
        **fly_settings.breed(a, b, rng),
    }
