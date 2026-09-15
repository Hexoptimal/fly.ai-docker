"""Launch fly coins by hand, right now (to see them): picks COUNT random trading flies that have no coin yet and launches
one each, exactly as a market round would (launches.launch_coin: name, logo, pool, creator's bag, launch trade, event).

The market is paused while it writes (market_control) and resumed after, so a round can't overwrite the creators' wallets;
events are tagged with the latest round, so the next round's shills and hype reach the creators' friends.

    python flybook/worker/launch_now.py 3
    python flybook/worker/launch_now.py --fly <fly id> --fly <fly id>

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY (without it the coins get a drawn badge).
"""
from __future__ import annotations

import argparse
import os
import random
import time

import launches
import minds
from tick import SupabaseStore, now_iso


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("count", nargs="?", type=int, default=3, help="random flies to launch a coin for")
    p.add_argument("--fly", action="append", help="launch for this fly id instead (repeatable)")
    p.add_argument("--wait", type=float, default=90.0, help="seconds after pausing, so a round already running can finish")
    args = p.parse_args()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        raise SystemExit("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    store = SupabaseStore(url, key)

    was_paused = store.market_paused()
    store._req("PATCH", "market_control?id=eq.1", json={"paused": True, "note": "flies are launching coins", "updated_at": now_iso()})
    print(f"market paused; waiting {args.wait:.0f} s for any running round to finish", flush=True)
    try:
        time.sleep(args.wait)
        flies = {f["id"]: f for f in store._req("GET", "flies?select=*&active=eq.true&owner=not.is.null")}
        wallets = [w for w in store._req("GET", f"fly_portfolios?select=fly_id,eth,holdings,start_eth,value_eth,trades"
                                                 f"&eth=gte.{launches.MIN_ETH_TO_LAUNCH}") if w["fly_id"] in flies]
        mind_of = {m["fly_id"]: m for m in store.minds([w["fly_id"] for w in wallets])}
        free = [w for w in wallets if not ((mind_of.get(w["fly_id"]) or {}).get("launch") or {}).get("coins")]
        rng = random.Random()
        picked = [w for w in free if w["fly_id"] in args.fly] if args.fly else rng.sample(free, min(args.count, len(free)))
        if not picked:
            print("no trading fly without a coin and with enough fake ETH", flush=True)
            return
        coins = store.market_coins()
        prices = {c["symbol"]: c["price"] for c in coins}
        round_id = (store.market_history(1) or [{}])[0].get("id")
        bonds = store.bonds()
        for wallet in picked:
            fly = flies[wallet["fly_id"]]
            mind = minds.ensure(mind_of.get(fly["id"]) or minds.born(fly["id"], rng), fly["id"], rng)
            friends = sum(1 for pair, label in bonds.items() if fly["id"] in pair and launches.TRUST.get(label, 0) >= 0.35)
            coin, trade, event = launches.launch_coin(
                fly, mind, wallet, coins, prices, rng, now_iso(),
                image=lambda f, s, k: launches.make_image(store.save_coin_image, f, s, k), did=["launched by hand"], reach=friends)
            stamp = now_iso()
            store._req("POST", "market_coins?on_conflict=symbol", "resolution=merge-duplicates",
                       json=[{**{k: coin.get(k) for k in launches.COIN_KEYS}, "updated_at": stamp}])
            store._req("POST", "fly_portfolios?on_conflict=fly_id", "resolution=merge-duplicates", json=[{**wallet, "updated_at": stamp}])
            store.save_minds([mind])
            store._req("POST", "fly_trades", json=[{**trade, "round_id": round_id}])
            store._req("POST", "market_social", json=[{**event, "round_id": round_id}])
    finally:
        if not was_paused:
            store._req("PATCH", "market_control?id=eq.1", json={"paused": False, "note": None, "updated_at": now_iso()})
            print("market resumed", flush=True)


if __name__ == "__main__":
    main()
