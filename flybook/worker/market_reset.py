"""Reset the fly market for real prices (2026-09-18): clear the fake-ETH era and start every fly again with paper USDG.

    python flybook/worker/market_reset.py            # dry run: what would be cleared
    python flybook/worker/market_reset.py --yes      # do it

With --yes it pauses the market (market_control), then deletes every trade, market round, market social event
(launches, shills, FUD) and market coin (the simulated coins and every fly-made coin), deletes every portfolio (the
worker opens a new CASH_START paper-USDG wallet for each holder's fly on its next tick), and resets what each fly's mind
learned: gains, urges, memory, tubes, stats and launch state go back to a newborn's. Traits, the owner's trading style
(learners and risk), the lineage's inherit style and parents stay. Then it resumes the market (--keep-paused leaves it
paused). Coin logos in the coins bucket are left alone. Reads flybook/.env.
"""
from __future__ import annotations

import argparse
import datetime as dt
import random

import requests

import minds
from market_control import env

TABLES = ["fly_trades", "market_social", "market_rounds", "market_coins", "fly_portfolios"]
FILTER = {"fly_trades": "id=gte.0", "market_social": "id=gte.0", "market_rounds": "id=gte.0",
          "market_coins": "symbol=neq.__none__", "fly_portfolios": "fly_id=not.is.null"}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--yes", action="store_true", help="really clear it (default: dry run)")
    p.add_argument("--keep-paused", action="store_true", help="leave the market paused afterwards")
    args = p.parse_args()
    url, key = env()
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def count(table: str) -> int:
        r = requests.head(f"{url}/rest/v1/{table}?{FILTER.get(table, 'fly_id=not.is.null')}&select=*",
                          headers={**h, "Prefer": "count=exact"}, timeout=30)
        r.raise_for_status()
        return int(r.headers.get("Content-Range", "*/0").split("/")[-1])

    for t in TABLES + ["fly_minds"]:
        print(f"{t:16} {count(t):7} rows" + ("  (learned state reset, traits and style kept)" if t == "fly_minds" else "  (deleted)"))
    if not args.yes:
        print("dry run: nothing changed. Run with --yes to clear.")
        return

    def control(paused: bool, note: str) -> None:
        requests.post(f"{url}/rest/v1/market_control?on_conflict=id", headers={**h, "Prefer": "resolution=merge-duplicates"},
                      timeout=30, json={"id": 1, "paused": paused, "note": note,
                                        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}).raise_for_status()

    control(True, "switching to real prices")
    for t in TABLES:
        requests.delete(f"{url}/rest/v1/{t}?{FILTER[t]}", headers=h, timeout=120).raise_for_status()
        print(f"cleared {t}")
    rows = requests.get(f"{url}/rest/v1/fly_minds?select=fly_id,traits,inherit,parents,learning", headers=h, timeout=60).json()
    rng = random.Random()
    fresh = []
    for m in rows:
        base = minds.born(m["fly_id"], rng, m.get("inherit"))
        fresh.append({**base, "traits": {**base["traits"], **(m.get("traits") or {})}, "parents": m.get("parents") or [],
                      "learning": m.get("learning") or base["learning"],
                      "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()})
    for i in range(0, len(fresh), 200):
        requests.post(f"{url}/rest/v1/fly_minds?on_conflict=fly_id", headers={**h, "Prefer": "resolution=merge-duplicates"},
                      timeout=120, json=fresh[i:i + 200]).raise_for_status()
    print(f"reset {len(fresh)} minds")
    if args.keep_paused:
        print("market left paused: python flybook/worker/market_control.py resume")
    else:
        control(False, None)
        print("market resumed: the next round trades real prices with paper USDG")


if __name__ == "__main__":
    main()
