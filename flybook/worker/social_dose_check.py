"""Shills and FUD after the saturating trust rule (launches.social_strength, encoder v2): are they graded in the brain?
An offline check with criteria fixed before running (2026-09-15).

Live flies (settings from a JSON list), each with its own resting baseline; a shill is the target sense alone and FUD the
threat sense alone, at the amount market.felt now gives for a stranger, a friend and two friends (and the old linear rule's
full strength for context). EPISODES brain seeds per level.

Pass criteria (fixed before running):
  S1 a friend's shill is not a sure buy: P(turned) at friend strength is between 0.20 and 0.85
  S2 shills are graded by trust: P(turned) stranger < friend < two friends, and two friends - stranger >= 0.20
  S3 a friend's FUD is not a sure panic: P(jumped) at friend strength is between 0.20 and 0.85
  S4 FUD is graded by trust: P(jumped) stranger < friend < two friends, and two friends - stranger >= 0.20

Results:
  run 1 (seed 3150, one curve K 1.25): NOT PASSED, S3 failed. turned stranger/friend/two friends .08/.58/.92 (old rule
        .96); jumped .08/.17/.50 (old rule .79). FUD got its own curve (launches.SOCIAL_K_THREAT 0.78) for run 2.
  run 2 (seed 3250, new seeds, FUD K 0.78): PASSED all four. turned stranger/friend/two friends .25/.62/.92 (old rule
        .96); jumped .00/.54/.67 (old rule .88). Flagged: run 2 follows a change made after run 1 failed.

    python flybook/worker/social_dose_check.py FLIES.json [--flies 12 --episodes 2 --seed 3150]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import launches
import market
from actions import ActionReader
from episode import Episodes
from settings import clean

TRUST = {"stranger": launches.STRANGER, "friend": launches.TRUST["friends"], "two friends": 2 * launches.TRUST["friends"]}


def amount(sense: str, strength: float) -> float:
    lo, hi = market.RANGE_V2[sense]
    return lo + (hi - lo) * strength


def rates(eps, reader, settings, sense, amt, seed, episodes) -> dict:
    hits = {"turned": 0, "jumped": 0, "groomed": 0, "n": 0}
    for e in range(episodes):
        drives = [{c: {"amount": amt if c == sense else 0.0} for c in ("target", "threat", "wind")} for _ in settings]
        did = market.run_brains(eps, reader, settings, drives, [0.0] * len(settings), seed + e)
        for acts in did:
            keys = {a["key"] for a in acts}
            for k in ("turned", "jumped", "groomed"):
                hits[k] += k in keys
            hits["n"] += 1
    return {k: round(v / hits["n"], 3) if k != "n" else v for k, v in hits.items()}


def graded(r: dict) -> bool:
    return r["stranger"] < r["friend"] < r["two friends"] and r["two friends"] - r["stranger"] >= 0.20


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("flies_json")
    p.add_argument("--flies", type=int, default=12)
    p.add_argument("--episodes", type=int, default=2)
    p.add_argument("--seed", type=int, default=3150)
    p.add_argument("--out", default="social_dose_check.json")
    args = p.parse_args()

    source = json.load(open(args.flies_json))[: args.flies]
    settings = [clean({k: f.get(k) or {} for k in ("senses", "temperament", "dials")}) for f in source]
    eps = Episodes(batch=len(settings))
    reader = ActionReader(eps)
    reader.fit()
    reader.fit_profiles(reader.missing(settings), seed=4242)

    report = {"criteria": __doc__.split("Pass criteria (fixed before running):")[1].split("python")[0].strip(),
              "flies": len(settings), "episodes": args.episodes, "levels": {}}
    seed = args.seed
    for sense, action in (("target", "turned"), ("threat", "jumped")):
        levels = {name: round(launches.social_strength(t, sense), 3) for name, t in TRUST.items()}
        levels["old rule, friend"] = 1.0
        out = {}
        for name, strength in levels.items():
            amt = amount(sense, strength)
            r = rates(eps, reader, settings, sense, amt, seed, args.episodes)
            seed += 1000
            out[name] = {"strength": strength, "amount": round(amt, 4), **r}
            print(f"{sense:6s} {name:17s} strength {strength:.2f} amount {amt:.4f} -> {r}", flush=True)
        report["levels"][sense] = out
    t = {k: v["turned"] for k, v in report["levels"]["target"].items()}
    j = {k: v["jumped"] for k, v in report["levels"]["threat"].items()}
    checks = {"S1": 0.20 <= t["friend"] <= 0.85, "S2": graded(t), "S3": 0.20 <= j["friend"] <= 0.85, "S4": graded(j)}
    report.update({"checks": checks, "passed": all(checks.values())})
    Path(args.out).write_text(json.dumps(report, indent=1))
    print(json.dumps({"checks": checks}, indent=1))
    print("PASSED" if report["passed"] else "NOT PASSED", flush=True)


if __name__ == "__main__":
    main()
