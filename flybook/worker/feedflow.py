"""The feed moves the fly market. What happened in the patches since the last market round reaches the trading flies'
senses (the brain still makes every trade), and people's likes bring outside buyers to fly coins.

  mood      a fly's own posts since the last round linger: a threat read or a jump -> its falling held coin looms harder
            (MOOD_PER threat each, capped); a 'mate' read, a turn or a walk -> the coin it notices pulls harder; a wind read
            or grooming -> the market feels choppier. Added on top of what the market itself does to that sense.
  set off   a neighbour whose brain set this fly off in the patch (a post's cause): its moves caught the fly's eye -> that
            neighbour's live coins pull like a shill (POST_TRUST per post); its jump startled the fly -> they loom, if held.
  crowd     likes and comments people gave a creator's posts since the last round buy into its live coins from outside
            (LIKE_ETH / COMMENT_ETH each, capped at CROWD_CAP a coin a round).
"""
from __future__ import annotations

import launches

MOOD_PER = {"threat": 0.25, "target": 0.15, "wind": 0.15}
MOOD_CAP = {"threat": 1.0, "target": 1.0, "wind": 0.6}
POST_TRUST = 0.5
POST_CAP = 2.0
LIKE_ETH, COMMENT_ETH, CROWD_CAP = 0.003, 0.005, 0.05


def acts(post: dict) -> set[str]:
    return {a.get("key") for a in (post.get("actions") or [])}


def by_fly(posts: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for p in posts:
        out.setdefault(p["fly_id"], []).append(p)
    return out


def mood(posts: list[dict]) -> dict[str, float]:
    """This fly's own posts since the last round as extra strength per market sense (0..cap)."""
    m = {"threat": 0.0, "target": 0.0, "wind": 0.0}
    for p in posts:
        a, word = acts(p), p.get("word")
        if word == "threat" or "jumped" in a:
            m["threat"] += MOOD_PER["threat"]
        if word == "mate" or a & {"turned", "walked"}:
            m["target"] += MOOD_PER["target"]
        if word == "wind" or "groomed" in a:
            m["wind"] += MOOD_PER["wind"]
    return {k: round(min(MOOD_CAP[k], v), 3) for k, v in m.items() if v > 0}


def set_off(fly_id: str, posts: list[dict], coins_of: dict[str, list[str]]) -> dict:
    """Neighbours whose brains set this fly off since the last round, as hype or fear for their live coins
    (same shape as launches.social_drive)."""
    target: dict[str, float] = {}
    threat: dict[str, float] = {}
    why: dict[str, list] = {}
    for p in posts:
        cause = p.get("cause") or {}
        src = cause.get("from_fly_id")
        if p.get("fly_id") != fly_id or not src or src == fly_id:
            continue
        scared = cause.get("channel") == "loom" or "jumped" in acts(p)
        for sym in coins_of.get(src, []):
            bag = threat if scared else target
            bag[sym] = min(POST_CAP, bag.get(sym, 0.0) + POST_TRUST)
            why.setdefault(sym, []).append({"from": src, "kind": "post", "label": "startled it" if scared else "caught its eye"})
    return {"target": target, "threat": threat, "why": why}


def merge(a: dict | None, b: dict) -> dict:
    """Add two social drives together."""
    if not a:
        return b
    out = {"target": dict(a["target"]), "threat": dict(a["threat"]), "why": {k: list(v) for k, v in a["why"].items()}}
    for bag in ("target", "threat"):
        for sym, v in b[bag].items():
            out[bag][sym] = out[bag].get(sym, 0.0) + v
    for sym, v in b["why"].items():
        out["why"].setdefault(sym, []).extend(v)
    return out


def crowd(coins: list[dict], likes: dict[str, int], comments: dict[str, int]) -> list[dict]:
    """People's likes and comments on a creator's posts buy into its live coins. Returns round events."""
    events = []
    for c in coins:
        if not launches.live(c) or not c.get("creator"):
            continue
        n_likes, n_comments = likes.get(c["creator"], 0), comments.get(c["creator"], 0)
        flow = min(CROWD_CAP, LIKE_ETH * n_likes + COMMENT_ETH * n_comments)
        if flow <= 0:
            continue
        before = c["price"]
        launches.buy(c, flow)
        events.append({"symbol": c["symbol"], "kind": "likes", "move": round(c["price"] / before - 1, 4),
                       "likes": n_likes, "comments": n_comments})
    return events
