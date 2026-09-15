"""Encoder v2 vs v1: does the market reach the flies' brains in a graded way? An offline check with criteria fixed
before running (2026-09-15).

Cohorts: the same flies (settings from a JSON list of real flies), the same simulated price paths, the same traits and
brain seeds, all learners on (what the live market runs); only the encoder and decoder differ:
  v1   raw % moves x fixed factors, clipped, up to 1.6 of stimulus; the first action in a fixed order becomes the trade
  v2   moves as z-scores against each coin's usual move, mapped into each sense's graded range (market.RANGE_V2), up
       to 0.8; the action with the strongest response relative to its own typical response becomes the trade
Every fly-round is logged (holds too). "Typical response" (pick_ref) is measured once at startup: the median z of turned
under the target sense, jumped under threat and groomed under wind, at v2's full strength, on these flies.

Pass criteria (fixed before running), all five for v2:
  C1 graded turning: over fly-rounds with a noticed coin, P(turned) rises across terciles of that coin's z
     (low < mid < high), the low tercile is at most 0.6, and high - low is at least 0.2
  C2 graded jumping: over fly-rounds holding a coin, P(jumped) rises across terciles of the worst held coin's drop
     (-z) the same way (low < mid < high, low <= 0.6, high - low >= 0.2)
  C3 fewer everything-at-once runs: the share of fly-rounds with 2+ actions is at most half of v1's
  C4 trade mix: buy, panic_sell, take_profit and sell are each at least 3% of v2's executed trades
  C5 not clearly worse: paired final log value v2 - v1 (same fly, same path), bootstrap 95% CI lower bound > -0.05
v1's C1-C3 numbers are reported next to v2's for context.

    python flybook/worker/market_encoder_eval.py FLIES.json [--paths 3 --rounds 40 --flies 12 --path-seed 2026]
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import numpy as np

import market
import minds
from actions import ActionReader, profile_key
from episode import Episodes
from settings import clean

COHORTS = {"v1": "v1", "v2": "v2"}
MIX = ["buy", "panic_sell", "take_profit", "sell"]


def ci(diffs: np.ndarray, rng: np.random.Generator, n: int = 10_000) -> tuple[float, float, float]:
    boots = rng.choice(diffs, size=(n, len(diffs)), replace=True).mean(1)
    return float(diffs.mean()), float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))


def graded(log: list[dict], signal: str, action: str, flip: bool = False) -> dict:
    rows = [(-(r[signal]) if flip else r[signal], action in r["did"]) for r in log if r[signal] is not None]
    if len(rows) < 30:
        return {"n": len(rows), "rates": None, "ok": False}
    x = np.array([v for v, _ in rows])
    y = np.array([a for _, a in rows], float)
    cuts = np.quantile(x, [1 / 3, 2 / 3])
    parts = [y[x <= cuts[0]], y[(x > cuts[0]) & (x <= cuts[1])], y[x > cuts[1]]]
    rates = [round(float(p.mean()), 3) if len(p) else float("nan") for p in parts]
    ok = rates[0] < rates[1] < rates[2] and rates[0] <= 0.6 and rates[2] - rates[0] >= 0.2
    return {"n": len(rows), "cuts": [round(float(c), 2) for c in cuts], "rates": rates, "ok": bool(ok)}


def pick_ref(eps: Episodes, reader: ActionReader, flies: list[dict], seed: int) -> dict:
    """Median z of each action under its own sense at v2's full strength, on these flies."""
    settings = [{k: f.get(k) or {} for k in ("senses", "temperament", "dials")} for f in flies]
    refs = {}
    for action, sense in (("turned", "target"), ("jumped", "threat"), ("groomed", "wind")):
        amount = market.RANGE_V2[sense][1]
        drives = [{c: {"amount": amount if c == sense else 0.0} for c in ("target", "threat", "wind")} for _ in flies]
        did = market.run_brains(eps, reader, settings, drives, [0.0] * len(flies), seed)
        zs = [a["z"] for acts in did for a in acts if a["key"] == action]
        refs[action] = round(float(np.median(zs)), 2) if zs else 3.0
        seed += 1
    refs["backed_up"] = 3.0
    return refs


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("flies_json")
    p.add_argument("--paths", type=int, default=3)
    p.add_argument("--rounds", type=int, default=40)
    p.add_argument("--flies", type=int, default=12)
    p.add_argument("--path-seed", type=int, default=2026)
    p.add_argument("--out", default="market_encoder_eval.json")
    args = p.parse_args()

    source = json.load(open(args.flies_json))
    flies = [{"id": f"eval-{i}", **{k: clean({k: f.get(k) or {} for k in ("senses", "temperament", "dials")})[k]
                                     for k in ("senses", "temperament", "dials")}} for i, f in enumerate(source[: args.flies])]
    eps = Episodes(batch=len(flies))
    reader = ActionReader(eps)
    reader.fit()
    t0 = time.perf_counter()
    reader.fit_profiles(reader.missing([{k: f.get(k) or {} for k in ("senses", "temperament", "dials")} for f in flies]), seed=4242)
    refs = pick_ref(eps, reader, flies, seed=args.path_seed * 7)
    print(f"{len(reader.own)} resting profiles in {time.perf_counter() - t0:.0f} s; pick_ref {refs}", flush=True)

    results = {c: {"final": [], "log": []} for c in COHORTS}
    for path in range(args.paths):
        price_rng = np.random.default_rng([args.path_seed, path])
        coins, moves = market.seed_coins(), []
        for _ in range(args.rounds):
            coins, events = market.move_prices(coins, price_rng)
            moves.append(([dict(c) for c in coins], events))
        born = {f["id"]: minds.born(f["id"], random.Random(f"{args.path_seed}-{path}-{f['id']}")) for f in flies}
        for cohort, encoder in COHORTS.items():
            t1 = time.perf_counter()
            state = {"coins": market.seed_coins(), "history": [], "portfolios": {}, "encoder": encoder,
                     "pick_ref": refs if encoder == "v2" else None, "log": [],
                     "minds": {k: json.loads(json.dumps(v)) for k, v in born.items()}}
            rng = np.random.default_rng([args.path_seed, path, 1])
            for r in range(args.rounds):
                market.simulate_round(state, eps, reader, rng, flies, dict(market.ALL_LEARNING), moved=moves[r],
                                      seed=args.path_seed * 1_000_000 + path * 100_000 + r * 97)
            results[cohort]["final"] += [math.log(max(1e-9, state["portfolios"][f["id"]]["value_eth"])) for f in flies]
            results[cohort]["log"] += state["log"]
            print(f"path {path} {cohort}: mean final {np.mean([state['portfolios'][f['id']]['value_eth'] for f in flies]):.3f} ETH, "
                  f"{time.perf_counter() - t1:.0f} s", flush=True)
            Path(args.out).with_suffix(".partial.json").write_text(json.dumps({"refs": refs, "done": f"{path}-{cohort}"}))

    report = {"criteria": __doc__.split("Pass criteria")[1].split("v1's C1")[0].strip(), "refs": refs,
              "paths": args.paths, "rounds": args.rounds, "flies": len(flies), "path_seed": args.path_seed, "cohorts": {}}
    for cohort in COHORTS:
        log = results[cohort]["log"]
        sides = [r["side"] for r in log if r["side"] in MIX]
        report["cohorts"][cohort] = {
            "fly_rounds": len(log),
            "turned_by_target_z": graded(log, "target_z", "turned"),
            "jumped_by_drop": graded(log, "threat_z", "jumped", flip=True),
            "multi_action_share": round(float(np.mean([len(r["did"]) >= 2 for r in log])), 3),
            "any_action_share": round(float(np.mean([len(r["did"]) >= 1 for r in log])), 3),
            "trade_mix": {s: round(sides.count(s) / max(1, len(sides)), 3) for s in MIX},
            "trades": len(sides),
            "mean_final_eth": round(float(np.mean(np.exp(results[cohort]["final"]))), 4),
        }
    v1, v2 = report["cohorts"]["v1"], report["cohorts"]["v2"]
    mean, lo, hi = ci(np.array(results["v2"]["final"]) - np.array(results["v1"]["final"]), np.random.default_rng(1))
    checks = {
        "C1": v2["turned_by_target_z"]["ok"],
        "C2": v2["jumped_by_drop"]["ok"],
        "C3": v2["multi_action_share"] <= 0.5 * v1["multi_action_share"],
        "C4": all(v2["trade_mix"][s] >= 0.03 for s in MIX),
        "C5": lo > -0.05,
    }
    report.update({"paired_log_diff_v2_minus_v1": round(mean, 4), "ci95": [round(lo, 4), round(hi, 4)],
                   "checks": checks, "passed": all(checks.values())})
    Path(args.out).write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))
    print("PASSED" if report["passed"] else "NOT PASSED", flush=True)


if __name__ == "__main__":
    main()
