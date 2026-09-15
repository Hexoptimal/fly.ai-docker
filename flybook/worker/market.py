"""Flybook fly market: holders' flies trade fake coins with fake ETH using their real brains, learn from how it went,
and pass what they are (and, by lineage, what they learned) to their children. See minds.py for the learning.

Everything is SIMULATED: prices follow a random process below, balances are fake ETH, nothing is real money or advice.

Each round (every --market-every seconds, after a tick):
  1. prices move: a random walk per coin with regimes (calm / pump / dump) and, for meme coins, rare pumps and rugs.
  2. each fly's result since last round is its reward; minds.learn turns it into dopamine (updating the gains and
     action biases behind last round's trade), stores last round's trade in memory, and grows its slime-mold tubes.
  3. the market becomes senses, per fly (hand-written encoder, the interface, like patch.py's channels):
       the coin pumping hardest, weighted by the fly's tube to it -> a moving fly-sized target (LC10a)
       its worst held coin falling                               -> a looming shape (LC4, LPLC2)
       a choppy market                                           -> wind on the antennae (Johnston's organ)
     each scaled by the fly's sense settings and its learned gain for that sense. Positive dopamine also drives its
     PAM reward neurons (0.3 x dopamine) during the run.
  4. the brain runs 1 s (fastbrain, the tick episode) and actions.ActionReader reads what it did against rest measured
     with its own settings.
  5. what it did becomes a trade (hand-written mapping, chosen from what these neurons actually do; the walking and
     backing-up neurons almost never fire in this model, so buying can't depend on them):
       jumped (escape)        -> panic-sell its worst held coin
       turned (steering)      -> buy the coin it noticed with `risk` of its ETH (x1.5 if it also buzzed its wings)
       groomed                -> take profit: sell a quarter of its best held coin
       backed up              -> sell half of its worst held coin
     then the fly's learning gets a say: an action whose learned bias fell below 0.15 is blocked, its memory can skip
     a trade that went badly in similar situations (a "skipped" row), and the size scales with the bias (x1.3 when
     memory says it went well). A 0.3% fee on every trade.
"""
from __future__ import annotations

import math
import random
import time

import numpy as np

import launches
import minds
from episode import AMOUNT, DT
from settings import clean

FEE = 0.003
MIN_TRADE_ETH = 0.001
HISTORY = 4                    # rounds of prices used for momentum (3-round moves)
PROFILE_FITS_PER_ROUND = 2
PAM_PER_DOPAMINE = 0.3
MAX_DRIVE = 1.6
ALL_LEARNING = {"dopamine": True, "memory": True, "tubes": True}


def learning_of(spec: str) -> dict[str, bool]:
    """'all', 'none', or a comma list of dopamine/memory/tubes (tick.py --market-learning)."""
    parts = {s.strip() for s in spec.split(",") if s.strip()}
    if parts == {"all"}:
        return dict(ALL_LEARNING)
    if parts - set(ALL_LEARNING) - {"none"}:
        raise ValueError(f"unknown learning {spec!r}: use all, none or a comma list of {', '.join(ALL_LEARNING)}")
    return {k: k in parts for k in ALL_LEARNING}

# symbol, name, kind, start price in ETH, volatility per round, drift per round
COINS = [
    ("BTC", "Bitcoin (simulated)", "real", 25.0, 0.020, 0.0005),
    ("SOL", "Solana (simulated)", "real", 0.05, 0.040, 0.0005),
    ("FLYAI", "$FLYAI (simulated)", "real", 0.000002, 0.080, 0.0),
    ("SUGAR", "Sugar Coin", "meme", 0.00001, 0.120, 0.0),
    ("SWAT", "Swatter Token", "meme", 0.00003, 0.140, -0.002),
    ("BUZZ", "Buzz", "meme", 0.00002, 0.160, 0.0),
    ("ROT", "Rotten Fruit", "meme", 0.000005, 0.200, 0.0),
]
KIND = {c[0]: c for c in COINS}
REGIME_SWITCH = {"real": 0.05, "meme": 0.15}   # chance per round of leaving the calm regime
REGIME_DRIFT = {"calm": 0.0, "pump": 0.06, "dump": -0.06}
SENSE_GAIN = {"target": "eyes", "threat": "eyes", "wind": "antennae"}


def seed_coins() -> list[dict]:
    return [{"symbol": s, "name": n, "kind": k, "price": p, "regime": "calm"} for s, n, k, p, _, _ in COINS]


def move_prices(coins: list[dict], rng: np.random.Generator) -> tuple[list[dict], list[dict]]:
    """One round of simulated price moves. Returns updated coins and notable events."""
    events, out = [], []
    for c in coins:
        spec = KIND.get(c["symbol"])
        if not spec:
            out.append(c)                    # fly-made coins move with their pools (launches.drift and trades)
            continue
        _, _, kind, _, vol, drift = spec
        regime = c.get("regime", "calm")
        if regime == "calm" and rng.random() < REGIME_SWITCH[kind]:
            regime = "pump" if rng.random() < 0.5 else "dump"
        elif regime != "calm" and rng.random() < 0.35:
            regime = "calm"
        step = drift + REGIME_DRIFT[regime] + vol * rng.standard_normal()
        if kind == "meme" and rng.random() < 0.03:
            jump = float(rng.uniform(0.3, 1.0))
            step += math.log1p(jump)
            events.append({"symbol": c["symbol"], "kind": "pump", "move": round(jump, 3)})
        if kind == "meme" and rng.random() < 0.015:
            rug = float(rng.uniform(0.4, 0.85))
            step += math.log1p(-rug)
            events.append({"symbol": c["symbol"], "kind": "rug", "move": round(-rug, 3)})
        out.append({**c, "price": max(1e-12, float(c["price"]) * math.exp(step)), "regime": regime})
    return out, events


def value(portfolio: dict, prices: dict) -> float:
    return portfolio["eth"] + sum(h["qty"] * prices.get(s, 0.0) for s, h in portfolio["holdings"].items())


def new_portfolio(fly_id: str) -> dict:
    return {"fly_id": fly_id, "eth": 1.0, "holdings": {}, "start_eth": 1.0, "value_eth": 1.0, "trades": 0}


def felt(portfolio: dict, prices: dict, history: list[dict], settings: dict, mind: dict, learning: dict | None = None,
         social: dict | None = None) -> dict:
    """What the market does to this fly's senses: amounts in stimulus units, after its settings and learned gains.
    A learner switched off is not used: dopamine off ignores learned gains, tubes off ignores tube thickness.
    social (launches.social_drive): shills and FUD from flies it has a relationship with; when that hits harder than the
    price moves, the shilled coin becomes the moving target, and a FUDed coin it holds becomes the looming shape."""
    learning = ALL_LEARNING if learning is None else learning
    old = history[-1] if history else {}
    moves = {s: prices[s] / old[s] - 1 for s in prices if old.get(s)}
    last = history[0] if history else {}
    chop = float(np.mean([abs(prices[s] / last[s] - 1) for s in prices if last.get(s)])) if last else 0.0
    senses = clean(settings)["senses"]
    gains = mind["learned"]["gains"] if learning.get("dopamine") else {}
    tube = (lambda s: minds.tube(mind, s)) if learning.get("tubes") else (lambda s: 1.0)

    def amount(sense: str, strength: float) -> float:
        return round(min(MAX_DRIVE, AMOUNT * senses.get(SENSE_GAIN[sense], 1.0) * gains.get(sense, 1.0) * float(np.clip(strength, 0, 1))), 4)

    mean_tube = float(np.mean([tube(s) for s in moves])) if moves else 1.0
    noticed = {s: m * tube(s) / mean_tube for s, m in moves.items() if m > 0}
    target = max(noticed, key=noticed.get) if noticed else None
    held = [s for s, h in portfolio["holdings"].items() if h["qty"] > 0 and s in moves]
    worst = min(held, key=lambda s: moves[s]) if held else None
    out = {
        "target": {"symbol": target, "move": round(moves[target], 4) if target else 0.0,
                   "tube": round(tube(target), 3) if target else 1.0,
                   "amount": amount("target", moves[target] * 4) if target else 0.0},
        "threat": {"symbol": worst, "move": round(moves[worst], 4) if worst else 0.0,
                   "amount": amount("threat", -moves[worst] * 3) if worst else 0.0},
        "wind": {"chop": round(chop, 4), "amount": amount("wind", chop * 8)},
    }
    if social and social["target"]:
        sym, trust = max(social["target"].items(), key=lambda kv: kv[1])
        hit = amount("target", min(1.0, launches.SOCIAL_TARGET * trust))
        if sym in prices and hit > out["target"]["amount"]:
            out["target"] = {"symbol": sym, "move": round(moves.get(sym, 0.0), 4), "tube": round(tube(sym), 3),
                             "amount": hit, "social": social["why"].get(sym, [])[:3]}
    held_now = {s for s, h in portfolio["holdings"].items() if h["qty"] > 0 and s in prices}
    if social and social["threat"]:
        scary = {s: v for s, v in social["threat"].items() if s in held_now}
        if scary:
            sym, trust = max(scary.items(), key=lambda kv: kv[1])
            hit = amount("threat", min(1.0, launches.SOCIAL_THREAT * trust))
            if hit > out["threat"]["amount"]:
                out["threat"] = {"symbol": sym, "move": round(moves.get(sym, 0.0), 4), "amount": hit,
                                 "social": social["why"].get(sym, [])[:3]}
    return out


def run_brains(eps, reader, settings: list[dict], drives: list[dict], rewards: list[float], seed: int):
    """One shared brain run for these flies; returns what each did (actions.ActionReader, own-settings rest)."""
    from actions import profile_key
    b = eps.brain
    B = len(settings)
    b.batch = B
    b.reset(seed)
    _, dials = eps.configure([clean(s) for s in settings], [(None, 0.0)] * B)
    inject = []
    for sense, word in (("target", "mate"), ("threat", "threat"), ("wind", "wind")):
        amounts = np.array([d[sense]["amount"] for d in drives], np.float32)
        if amounts.any():
            inject.append((eps.cells[word], amounts))
    pam = np.array([PAM_PER_DOPAMINE * max(0.0, r) for r in rewards], np.float32)
    if pam.any():
        inject.append((eps.dial_cells["reward"], pam))
    acc = np.zeros((B, len(eps.dn) + 1))
    for s in range(eps.warm + eps.stim):
        fired = b.step(inject=dials + (inject if s >= eps.warm else []))
        if s < eps.warm:
            continue
        for i, f in enumerate([fired] if B == 1 else fired):
            c = eps.col[f]
            np.add.at(acc[i], c[c >= 0], 1)
    counts, wing = acc[:, :-1], acc[:, -1] / (eps.stim * DT)
    return reader.read(counts, wing, [profile_key(s) for s in settings])


def decide(portfolio: dict, did: list[dict], drive: dict, prices: dict, mind: dict, learning: dict,
           rng: random.Random | None = None, pools: dict | None = None) -> tuple[dict | None, str, dict]:
    """The fly's actions as a trade, after its learning has had a say. Mutates the portfolio.
    pools: fly-made coins by symbol; trades in them go through the coin's pool and move its price (launches.py).
    Returns (trade or None, action name or 'hold', a note for the trade's reason)."""
    keys = {a["key"] for a in did}
    pools = pools or {}
    held = {s: h for s, h in portfolio["holdings"].items() if h["qty"] > 0 and s in prices}
    if drive["target"]["symbol"] in pools and not launches.live(pools[drive["target"]["symbol"]]):
        drive = {**drive, "target": {**drive["target"], "symbol": None}}        # nobody can buy a dead coin
    pnl = lambda s: held[s]["qty"] * prices[s] - held[s]["cost_eth"]
    if "jumped" in keys and held:
        action, symbol = "panic_sell", drive["threat"]["symbol"] or min(held, key=pnl)
    elif "turned" in keys and drive["target"]["symbol"]:
        action, symbol = "buy", drive["target"]["symbol"]
    elif "groomed" in keys and held:
        action, symbol = "take_profit", max(held, key=pnl)
    elif "backed_up" in keys and held:
        action, symbol = "sell", min(held, key=pnl)
    else:
        return None, "hold", {}

    bias = mind["learned"]["bias"].get(action, 1.0)
    total = value(portfolio, prices)
    state = minds.situation(drive, 1 - portfolio["eth"] / total if total > 0 else 0.0)
    note: dict = {"bias": round(bias, 3), "state": state}
    skip = lambda why: ({"symbol": symbol, "side": "skipped", "qty": 0.0, "price": prices[symbol], "eth": 0.0,
                         "wanted": action}, "skipped", {**note, "skipped": why})
    if learning.get("dopamine") and bias < minds.BIAS_BLOCK:
        return skip("dopamine had turned this action off")
    size = bias if learning.get("dopamine") else 1.0
    if learning.get("memory"):
        mean, n = minds.recall(mind, state, action)
        caution = mind["traits"]["caution"]
        if mean is not None and n >= int(mind["traits"]["k"]):
            note["memory"] = {"mean_reward": round(mean, 4), "similar": n}
            if mean < -caution and (rng or random).random() >= minds.EXPLORE:
                return skip("it remembered this going badly")
            if mean > caution:
                size *= 1.3

    if action == "buy":
        spend = min(portfolio["eth"], portfolio["eth"] * mind["traits"]["risk"] * (1.5 if "buzzed" in keys else 1.0) * size)
        if spend < MIN_TRADE_ETH:
            return None, "hold", {}
        if symbol in pools:
            qty = launches.buy(pools[symbol], spend)
            prices[symbol] = pools[symbol]["price"]
        else:
            qty = spend * (1 - FEE) / prices[symbol]
        h = portfolio["holdings"].setdefault(symbol, {"qty": 0.0, "cost_eth": 0.0})
        h["qty"] += qty
        h["cost_eth"] += spend
        portfolio["eth"] -= spend
        return {"symbol": symbol, "side": "buy", "qty": qty, "price": prices[symbol], "eth": spend}, action, note

    share = {"panic_sell": 1.0, "take_profit": 0.25, "sell": 0.5}[action] * min(1.0, size)
    h = held[symbol]
    qty = h["qty"] * share
    if symbol in pools:
        if not launches.live(pools[symbol]):
            return None, "hold", {}
        if launches.quote_sell(pools[symbol], qty) < MIN_TRADE_ETH:              # quote first: tiny sells are skipped
            return None, "hold", {}
        got = launches.sell(pools[symbol], qty)
        prices[symbol] = pools[symbol]["price"]
    else:
        got = qty * prices[symbol] * (1 - FEE)
    if got < MIN_TRADE_ETH:
        return None, "hold", {}
    h["cost_eth"] *= (1 - share)
    h["qty"] -= qty
    if h["qty"] <= 1e-18 or share >= 0.999:
        portfolio["holdings"].pop(symbol, None)
    portfolio["eth"] += got
    return {"symbol": symbol, "side": action, "qty": qty, "price": prices[symbol], "eth": got}, action, note


def simulate_round(state: dict, eps, reader, rng: np.random.Generator, flies: list[dict],
                   learning: dict | None = None, moved: tuple[list[dict], list[dict]] | None = None, seed: int | None = None) -> dict:
    """One round on in-memory state {coins, history (newest first), portfolios, minds}. moved: prices already moved
    (the offline check shares one price path between cohorts). learning: force these learners on every fly (the
    offline check's cohorts); None uses each fly's own choice (mind["learning"], set by its owner). Returns {round, trades}."""
    t0 = time.perf_counter()
    py_rng = random.Random(int(rng.integers(2**31)))
    coins = state.get("coins") or seed_coins()
    old_prices = {c["symbol"]: c["price"] for c in coins}
    coins, events = moved if moved else move_prices(coins, rng)
    fly_market = bool(state.get("launches"))              # fly-made coins, shills and FUD (off in the offline check)
    if fly_market:
        events = events + launches.drift(coins, rng)
    state["coins"] = coins
    prices = {c["symbol"]: c["price"] for c in coins}
    history = state.get("history", [])
    last = history[0] if history else {}
    recent = {s: prices[s] / last[s] - 1 for s in prices if last.get(s)}      # since last round (creators watch this)
    pools = {c["symbol"]: c for c in coins if c.get("kind") == "fly"}
    live_symbols = {s for s, c in pools.items() if launches.live(c)}
    bonds, social_in = state.get("bonds") or {}, state.get("social") or []
    settings_of = lambda f: {k: f.get(k) or {} for k in ("senses", "temperament", "dials")}

    dopamine, own = {}, {}
    for f in flies:
        p = state["portfolios"].setdefault(f["id"], new_portfolio(f["id"]))
        mind = minds.ensure(state["minds"].setdefault(f["id"], minds.born(f["id"], py_rng)), f["id"], py_rng)
        own[f["id"]] = learning if learning is not None else \
            {k: bool((mind.get("learning") or {}).get(k, True)) for k in ALL_LEARNING}
        before = max(1e-12, float(p.get("value_eth") or value(p, old_prices)))
        flux = {s: h["qty"] * (prices[s] - old_prices.get(s, prices[s])) / before for s, h in p["holdings"].items() if s in prices}
        dopamine[f["id"]] = minds.learn(mind, prices, flux, own[f["id"]])
        p["value_eth"] = value(p, prices)

    new = reader.missing([settings_of(f) for f in flies])
    if new:
        reader.fit_profiles(new[:PROFILE_FITS_PER_ROUND], seed=int(rng.integers(2**31)))

    trades = []
    did_by_fly: dict[str, set] = {}
    traded: dict[str, list[dict]] = {}
    seed = int(rng.integers(2**31)) if seed is None else seed
    for start in range(0, len(flies), eps.max_batch):
        batch = flies[start:start + eps.max_batch]
        drives = [felt(state["portfolios"][f["id"]], prices, history, settings_of(f), state["minds"][f["id"]], own[f["id"]],
                       launches.social_drive(f["id"], social_in, bonds, live_symbols) if fly_market else None) for f in batch]
        rewards = [dopamine[f["id"]] if own[f["id"]].get("dopamine") else 0.0 for f in batch]
        did = run_brains(eps, reader, [settings_of(f) for f in batch], drives, rewards, seed + start)
        for f, acts, drive in zip(batch, did, drives):
            p, mind = state["portfolios"][f["id"]], state["minds"][f["id"]]
            keys = {a["key"] for a in acts}
            did_by_fly[f["id"]] = keys
            made = launches.creator_trade(p, keys, pools, recent, mind, prices) if fly_market else None
            trade, action, note = made if made else decide(p, acts, drive, prices, mind, own[f["id"]], py_rng, pools)
            if trade and trade["side"] != "skipped":
                traded.setdefault(f["id"], []).append(trade)
            p["value_eth"] = value(p, prices)
            if trade and action in minds.ACTIONS:
                minds.open_trade(mind, trade["symbol"], trade["price"], action,
                                 {c: round(drive[c]["amount"] / AMOUNT, 4) for c in minds.CHANNELS}, note.get("state", []))
            if not trade:
                continue
            if trade["side"] == "skipped":
                mind["stats"]["vetoes"] += 1
            else:
                p["trades"] = int(p.get("trades", 0)) + 1
            trades.append({**{k: v for k, v in trade.items() if k != "wanted"}, "fly_id": f["id"], "value_after": p["value_eth"],
                           "reason": {"felt": drive, "did": [a["key"] + (f" {a['side']}" if a.get("side") else "") for a in acts],
                                      "dopamine": round(dopamine[f["id"]], 3), "gains": mind["learned"]["gains"],
                                      **({"wanted": trade["wanted"]} if "wanted" in trade else {}),
                                      **{k: v for k, v in note.items() if k != "state"}}})

    social = []
    if fly_market:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
        social, launched = launches.after_round(state, flies, did_by_fly, traded, prices, dopamine, py_rng, stamp)
        trades += launched
        events = events + [{"symbol": t["symbol"], "kind": "launch", "move": 0.0} for t in launched]
        for f in flies:
            p = state["portfolios"][f["id"]]
            p["value_eth"] = value(p, prices)
    state["history"] = ([prices] + history)[:HISTORY]
    return {"round": {"prices": prices, "events": events, "traders": len(flies),
                      "trades": sum(t["side"] != "skipped" for t in trades), "seconds": round(time.perf_counter() - t0, 1)},
            "trades": trades, "social": social}


def market_round(store, eps, reader, rng: np.random.Generator, flies: list[dict], learning: dict | None = None) -> dict:
    """Load the market, run one round for these flies, save it. learning: force these learners on every fly
    (None: each fly's owner's choice). Flies launch, shill and FUD coins here (launches.py)."""
    ids = [f["id"] for f in flies]
    state = {"coins": store.market_coins(), "history": [r["prices"] for r in store.market_history(HISTORY)],
             "portfolios": {p["fly_id"]: p for p in store.portfolios(ids)}, "minds": {m["fly_id"]: m for m in store.minds(ids)},
             "launches": True, "social": [], "bonds": {}, "launch_budget": 0}
    try:                                   # relationships and last round's drama; the round still runs without them
        state["bonds"] = store.bonds()
        state["social"] = store.recent_social()
        state["launch_budget"] = max(0, launches.DAILY_CAP - store.launches_today())
    except Exception as e:
        print(f"fly coins: couldn't load bonds or social events: {e}", flush=True)
    state["image"] = lambda fly, symbol, key: launches.make_image(store.save_coin_image, fly, symbol, key)
    out = simulate_round(state, eps, reader, rng, flies, learning)
    rnd = out["round"]
    store.save_market(rnd, state["coins"], [state["portfolios"][i] for i in ids], out["trades"], [state["minds"][i] for i in ids],
                      out["social"])
    skipped = sum(t["side"] == "skipped" for t in out["trades"])
    kinds = {k: sum(e["kind"] == k for e in out["social"]) for k in ("launch", "shill", "fud", "buyback", "dump")}
    print(f"market round: {len(flies)} traders, {rnd['trades']} trades, {skipped} skipped by learning, "
          f"fly coins {kinds}, events {rnd['events']}, {rnd['seconds']} s", flush=True)
    return rnd
