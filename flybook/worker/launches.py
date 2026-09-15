"""Flies launch their own coins in the fly market, shill them, FUD their enemies' coins, buy back and dump.

Everything is SIMULATED: fake coins, fake ETH. The brain still makes every move; this module decides what a fly CAN do
and turns relationships into what other flies SENSE:

  launch    each round a trading fly's launch urge grows with its personality (risk trait, excitability) and what its
            brain did (buzzing wings, positive dopamine). Once it has traded MIN_ROUNDS rounds and the urge is full it
            launches with LAUNCH_CHANCE a round, so launches come with delays. A second coin: a SECOND_CHANCE chance per round, only
            SECOND_AFTER rounds after its first. At most MAX_COINS_PER_FLY per fly, DAILY_CAP launches a day for everyone,
            LIVE_CAP live fly coins, LAUNCHES_PER_ROUND per round.
            The coin: a name and tagline from the fly's name and personality (templates, no AI text), and a logo from the
            cheapest image model we measured (IMAGE_MODEL, ~$0.0023, 2026-09-15; a drawn badge if that fails).
  pool      the creator seeds SEED_ETH; the pool holds the rest of the supply and the creator keeps CREATOR_SHARE.
            Buys and sells go through the pool (constant product, 0.3% fee), so buying pumps it and dumping crashes it.
            Outside traders add a little noise each round; a pool drained below DEAD_ETH is dead.
  shill     a fly whose wing neurons buzzed shills its newest live coin (or its biggest fly-coin bag)
  fud       a fly whose escape neurons fired FUDs a live coin made by its enemy, frenemy or rival (or a fly coin it just
            panic-sold)
  buyback / dump   a creator whose coin fell BUYBACK_DROP or more since last round: turned or groomed -> buys back with part
            of its ETH; jumped -> dumps half its bag
Next round, shills, launches and buybacks are a moving target (LC10a) for flies that trust the shiller (friends, mates,
family) and a looming shape on held coins for its enemies; FUD is a looming shape on that coin for flies that trust the
FUDer; a dump looms for every holder. Relationships come from fly_bonds() (what their brains did to each other).
"""
from __future__ import annotations

import base64
import io
import math
import os
import random
import re
import uuid
from pathlib import Path

import requests

MAX_COINS_PER_FLY = 2
MIN_ROUNDS = 12             # rounds a fly trades before it can launch its first coin (~2 h at 10 min rounds)
LAUNCH_CHANCE = 0.15        # chance per round once the urge is full
SECOND_AFTER = 36           # rounds after its first launch before a second is possible (~6 h)
SECOND_CHANCE = 0.0007      # chance per round of a second coin: about 10% a day at 144 rounds a day
LAUNCHES_PER_ROUND = 2
DAILY_CAP = int(os.environ.get("FLYBOOK_COIN_DAILY_CAP", "12"))
LIVE_CAP = 40
SEED_ETH = 0.1
MIN_ETH_TO_LAUNCH = 0.15
SUPPLY = 1_000_000_000.0
CREATOR_SHARE = 0.2
FEE = 0.003
DEAD_ETH = 0.005
CROWD = 0.04                # outside traders' flow per round, as a share of the pool's ETH (random sign)
BUYBACK_DROP = -0.08
BUYBACK_SHARE = 0.5         # of its usual buy size (risk x ETH)
DUMP_SHARE = 0.5
SHILL_MIN_SHARE = 0.05      # a holder shills a fly coin that is at least this share of its portfolio
# stimulus per unit of trust, capped at one direct stimulus. Was 0.6: on the first live round after 3 launches
# (2026-09-15, round 56) a plain pump (SUGAR) out-shouted every friend's launch, so no hype reached a brain
SOCIAL_TARGET, SOCIAL_THREAT = 1.0, 1.0

OPENROUTER = "https://openrouter.ai/api/v1"
IMAGE_MODEL = os.environ.get("FLYBOOK_COIN_MODEL", "openai/gpt-image-1-mini")
IMAGE_SIZE = 512
FONT = Path(__file__).resolve().parent / "fonts" / "Anton-Regular.ttf"

# how much a fly believes another fly's shill or FUD, by their relationship (strangers: no bond row)
TRUST = {"best friends": 1.3, "mates": 1.3, "friends": 1.0, "family": 1.0, "acquaintances": 0.35, "frenemies": 0.5,
         "rivals": 0.2, "enemies": 0.0}
STRANGER = 0.15
DISTRUST = {"enemies": 0.8, "frenemies": 0.4, "rivals": 0.3}     # an enemy shilling reads as a threat
HOSTILE = {"enemies", "frenemies", "rivals"}

# the market_coins columns a fly coin writes (a bulk upsert needs the same keys on every row)
COIN_KEYS = ["symbol", "name", "kind", "price", "regime", "creator", "persona", "tagline", "image_path", "image_model",
             "image_cost", "launched_at", "launch_price", "supply", "pool_eth", "pool_tokens", "status"]

THEMES = {
    "degen": {"nouns": ["Moon", "Rocket", "Lambo", "Pump", "Ape"],
              "taglines": ["Wings up, send it.", "Buzzing straight to the moon.", "Full degen, tiny brain.", "Bought the top. Made the top."],
              "motif": "riding a tiny rocket trailing sparks", "rim": "gold"},
    "jumpy": {"nouns": ["Panic", "Zoom", "Hop", "Flinch", "Jolt"],
              "taglines": ["Launched it, then jumped.", "Nervous but bullish.", "One shadow and I'm out.", "Scared money, fast wings."],
              "motif": "mid-jump with motion lines and wide startled eyes", "rim": "silver"},
    "chill": {"nouns": ["Nectar", "Chill", "Zen", "Drift", "Sip"],
              "taglines": ["Slow wings, strong hands.", "Just vibing on a banana.", "No rush. No rug. Probably.", "Hold it like a warm fruit."],
              "motif": "relaxing on a slice of banana with a tiny drink", "rim": "bronze"},
    "watcher": {"nouns": ["Eye", "Scout", "Radar", "Watch", "Lens"],
                "taglines": ["Saw it first.", "All eyes on the chart.", "Thousands of lenses, one coin.", "Watching you watch me."],
                "motif": "peering through a tiny telescope", "rim": "teal"},
    "normie": {"nouns": ["Coin", "Token", "Bucks", "Cash", "Gold"],
               "taglines": ["Just a fly with a coin.", "Buzz buzz, buy buy.", "Fruit flies, fruit gains.", "Started from the fruit bowl."],
               "motif": "proudly holding a tiny slice of fruit", "rim": "gold"},
}


def clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


# ---- the pool ----

def pool_price(coin: dict) -> float:
    return max(1e-18, coin["pool_eth"] / max(coin["pool_tokens"], 1e-9))


def live(coin: dict) -> bool:
    return coin.get("kind") == "fly" and coin.get("status", "live") == "live"


def buy(coin: dict, eth_in: float) -> float:
    """Spend eth_in on the pool; returns tokens out and moves the price."""
    k = coin["pool_eth"] * coin["pool_tokens"]
    coin["pool_eth"] += eth_in * (1 - FEE)
    out = coin["pool_tokens"] - k / coin["pool_eth"]
    coin["pool_tokens"] -= out
    coin["price"] = pool_price(coin)
    return max(0.0, out)


def sell(coin: dict, tokens_in: float) -> float:
    """Sell tokens into the pool; returns ETH out (after the fee) and moves the price."""
    k = coin["pool_eth"] * coin["pool_tokens"]
    coin["pool_tokens"] += tokens_in
    new_eth = k / coin["pool_tokens"]
    out = (coin["pool_eth"] - new_eth) * (1 - FEE)
    coin["pool_eth"] = new_eth + (coin["pool_eth"] - new_eth) * FEE
    coin["price"] = pool_price(coin)
    return max(0.0, out)


def quote_sell(coin: dict, tokens_in: float) -> float:
    """ETH a sell would get, without touching the pool."""
    return sell(dict(coin), tokens_in)


def drift(coins: list[dict], rng) -> list[dict]:
    """Outside traders nudge every live fly coin; a drained pool dies. Returns events for the round row."""
    events = []
    for c in coins:
        if not live(c):
            continue
        flow = CROWD * c["pool_eth"] * float(rng.standard_normal())
        if flow > 0:
            buy(c, flow)
        elif flow < 0:
            sell(c, min(c["pool_tokens"] * 0.2, -flow / pool_price(c)))
        if c["pool_eth"] < DEAD_ETH:
            c["status"] = "dead"
            events.append({"symbol": c["symbol"], "kind": "died", "move": -1.0})
    return events


# ---- who the fly is ----

def launch_state(mind: dict) -> dict:
    st = mind.setdefault("launch", {})
    st.setdefault("urge", 0.0)
    st.setdefault("coins", [])
    st.setdefault("rounds", 0)
    st.setdefault("last_round", None)
    return st


def persona(fly: dict, mind: dict) -> str:
    t, d, s = fly.get("temperament") or {}, fly.get("dials") or {}, fly.get("senses") or {}
    risk = float(mind.get("traits", {}).get("risk", 0.25))
    excitability = float(t.get("excitability", 1.0) or 1.0)
    if risk >= 0.32:
        return "degen"
    if d.get("escape") == "boost" or excitability >= 1.1:
        return "jumpy"
    if d.get("escape") == "off" or excitability <= 0.95:
        return "chill"
    if float(s.get("eyes", 1.0) or 1.0) >= 1.3:
        return "watcher"
    return "normie"


def grow_urge(fly: dict, mind: dict, did: set[str], dopamine: float) -> None:
    """Once a round: the itch to launch grows with personality and what its brain just did."""
    st = launch_state(mind)
    st["rounds"] += 1
    risk = clip((float(mind["traits"].get("risk", 0.25)) - 0.10) / 0.30, 0, 1)
    excitability = clip((float((fly.get("temperament") or {}).get("excitability", 1.0) or 1.0) - 0.9) / 0.3, 0, 1)
    gain = 0.05 + 0.12 * risk + 0.06 * excitability + 0.08 * max(0.0, dopamine) \
        + (0.15 if "buzzed" in did else 0.0) + (0.05 if "turned" in did else 0.0)
    st["urge"] = round(min(3.0, st["urge"] + gain), 4)


def wants_launch(mind: dict, portfolio: dict, rng: random.Random) -> bool:
    st = launch_state(mind)
    made = len(st["coins"])
    if made >= MAX_COINS_PER_FLY or portfolio["eth"] < MIN_ETH_TO_LAUNCH or st["rounds"] < MIN_ROUNDS:
        return False
    if made == 0:
        return st["urge"] >= 1.0 and rng.random() < LAUNCH_CHANCE
    return st["last_round"] is not None and st["rounds"] - st["last_round"] >= SECOND_AFTER and rng.random() < SECOND_CHANCE


def symbol_for(fly_name: str, noun: str, taken: set[str]) -> str:
    letters = re.sub(r"[^A-Za-z0-9]", "", fly_name).upper() or "FLY"
    options = [letters[:4], letters[:3] + noun[:2].upper(), (letters[:2] + noun[:3]).upper(), noun.upper()[:5]]
    options += [f"{letters[:3]}{n}" for n in range(2, 1000)]
    for sym in options:
        sym = sym[:6]
        if len(sym) >= 2 and sym not in taken:
            return sym
    return f"F{uuid.uuid4().hex[:5].upper()}"


# ---- the logo ----

def coin_prompt(fly: dict, key: str) -> str:
    from memes import color_name
    theme = THEMES[key]
    return (f"A round meme coin logo: a cute cartoon fruit fly (a fruit fly, not a bee: slim body, no stripes, no stinger) "
            f"with a {color_name(fly.get('color', ''))} body, big round glossy red compound eyes, two short antennae and "
            f"clear wings, {theme['motif']}, centred inside a shiny {theme['rim']} coin badge, flat vector sticker style, "
            "bold outline, plain dark background. No text, no letters, no numbers, no logos.")


def generate(prompt_text: str) -> tuple[bytes, float | None]:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("no OPENROUTER_API_KEY")
    r = requests.post(f"{OPENROUTER}/images", timeout=120, headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        "HTTP-Referer": "https://www.flyaiworld.com/flybook/", "X-Title": "Flybook"},
        json={"model": IMAGE_MODEL, "prompt": prompt_text, "aspect_ratio": "1:1", "quality": "low"})
    r.raise_for_status()
    body = r.json()
    return base64.b64decode(body["data"][0]["b64_json"]), (body.get("usage") or {}).get("cost")


def to_webp(png: bytes) -> bytes:
    from PIL import Image
    img = Image.open(io.BytesIO(png)).convert("RGB")
    side = min(img.size)
    img = img.crop(((img.width - side) // 2, (img.height - side) // 2, (img.width + side) // 2, (img.height + side) // 2))
    out = io.BytesIO()
    img.resize((IMAGE_SIZE, IMAGE_SIZE), Image.LANCZOS).save(out, "WEBP", quality=80, method=5)
    return out.getvalue()


def badge(color: str, symbol: str) -> bytes:
    """A drawn coin when the image model can't be reached: the fly's colour and its ticker."""
    from PIL import Image, ImageDraw, ImageFont
    rgb = tuple(int(color.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)) if re.fullmatch(r"#[0-9a-fA-F]{6}", color or "") else (224, 52, 44)
    img = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), (13, 17, 23))
    draw = ImageDraw.Draw(img)
    draw.ellipse((40, 40, IMAGE_SIZE - 40, IMAGE_SIZE - 40), fill=(242, 181, 68), outline=(120, 80, 20), width=14)
    draw.ellipse((90, 90, IMAGE_SIZE - 90, IMAGE_SIZE - 90), fill=rgb, outline=(30, 20, 10), width=6)
    font = ImageFont.truetype(str(FONT), 120 if len(symbol) <= 4 else 90)
    w = draw.textlength(symbol, font=font)
    draw.text(((IMAGE_SIZE - w) / 2, IMAGE_SIZE / 2 - font.size * 0.62), symbol, font=font, fill="white",
              stroke_width=6, stroke_fill="black")
    out = io.BytesIO()
    img.save(out, "WEBP", quality=85)
    return out.getvalue()


def make_image(save, fly: dict, symbol: str, key: str) -> dict:
    """Generate (or draw) the coin's logo and store it with save(path, bytes). Never raises."""
    path = f"{symbol.lower()}-{uuid.uuid4().hex[:8]}.webp"
    try:
        png, cost = generate(coin_prompt(fly, key))
        data, model = to_webp(png), IMAGE_MODEL
    except Exception as e:
        print(f"coin image for ${symbol} failed, drawing a badge: {e}", flush=True)
        data, cost, model = badge(fly.get("color", ""), symbol), 0.0, "badge"
    try:
        save(path, data)
    except Exception as e:
        print(f"coin image for ${symbol} not saved: {e}", flush=True)
        return {"image_path": None, "image_model": model, "image_cost": cost}
    return {"image_path": path, "image_model": model, "image_cost": cost}


# ---- what other flies feel ----

def social_drive(fly_id: str, events: list[dict], bonds: dict, live_symbols: set[str]) -> dict:
    """Last round's launches, shills, FUD, buybacks and dumps as this fly feels them, weighted by who posted them."""
    target: dict[str, float] = {}
    threat: dict[str, float] = {}
    why: dict[str, list] = {}

    def add(bag: dict, sym: str, w: float, e: dict, label: str | None) -> None:
        bag[sym] = bag.get(sym, 0.0) + w
        why.setdefault(sym, []).append({"from": e.get("fly_id"), "kind": e["kind"], "label": label or "stranger"})

    for e in events:
        src, sym = e.get("fly_id"), e.get("symbol")
        if not sym or sym not in live_symbols or src == fly_id:
            continue
        label = bonds.get(pair(fly_id, src)) if src else None
        trust = TRUST.get(label, STRANGER) if label else STRANGER
        if e["kind"] in ("launch", "shill", "buyback"):
            w = trust * (0.6 if e["kind"] == "buyback" else 1.0)
            if w > 0:
                add(target, sym, w, e, label)
            if DISTRUST.get(label or ""):
                add(threat, sym, DISTRUST[label], e, label)
        elif e["kind"] == "fud" and trust > 0:
            add(threat, sym, trust, e, label)
        elif e["kind"] == "dump":
            add(threat, sym, 1.0, e, label)
    return {"target": target, "threat": threat, "why": why}


# ---- creators ----

def creator_trade(portfolio: dict, did: set[str], pools: dict, recent: dict, mind: dict, prices: dict):
    """A creator watching its own coin fall: turned/groomed -> buy back, jumped -> dump half its bag.
    Returns (trade, action, note) like market.decide, or None."""
    for sym in reversed(launch_state(mind)["coins"]):
        coin = pools.get(sym)
        if not coin or not live(coin) or recent.get(sym, 0.0) > BUYBACK_DROP:
            continue
        held = portfolio["holdings"].get(sym)
        note = {"own_coin": sym, "fell": round(recent[sym], 4)}
        if "jumped" in did and held and held["qty"] > 0:
            qty = held["qty"] * DUMP_SHARE
            got = sell(coin, qty)
            held["cost_eth"] *= 1 - DUMP_SHARE
            held["qty"] -= qty
            portfolio["eth"] += got
            prices[sym] = coin["price"]
            return {"symbol": sym, "side": "dump", "qty": qty, "price": coin["price"], "eth": got}, "dump", note
        if did & {"turned", "groomed"}:
            spend = min(portfolio["eth"], portfolio["eth"] * float(mind["traits"].get("risk", 0.25)) * BUYBACK_SHARE)
            if spend < 0.001:
                continue
            qty = buy(coin, spend)
            h = portfolio["holdings"].setdefault(sym, {"qty": 0.0, "cost_eth": 0.0})
            h["qty"] += qty
            h["cost_eth"] += spend
            portfolio["eth"] -= spend
            prices[sym] = coin["price"]
            return {"symbol": sym, "side": "buyback", "qty": qty, "price": coin["price"], "eth": spend}, "buyback", note
    return None


# ---- after the brains ran ----

def after_round(state: dict, flies: list[dict], did: dict[str, set], traded: dict[str, list[dict]], prices: dict,
                dopamine: dict[str, float], rng: random.Random, now_iso: str) -> tuple[list[dict], list[dict]]:
    """Shills, FUD and launches from what each fly's brain did this round. Returns (social events, launch trades).
    Adds new coins to state["coins"] and their prices to `prices`."""
    coins = state["coins"]
    pools = {c["symbol"]: c for c in coins if c.get("kind") == "fly"}
    bonds = state.get("bonds") or {}
    budget = int(state.get("launch_budget", DAILY_CAP))
    live_count = sum(live(c) for c in coins)
    social, launch_trades = [], []
    ids = [f["id"] for f in flies]

    def reach(src: str, friendly: bool) -> int:
        labels = [bonds.get(pair(src, o)) for o in ids if o != src]
        return sum(1 for l in labels if (TRUST.get(l, 0) >= 0.35) == friendly and l is not None and (friendly or l in HOSTILE))

    order = list(flies)
    rng.shuffle(order)
    launched = 0
    for f in order:
        fid, keys = f["id"], did.get(f["id"], set())
        p, mind = state["portfolios"][fid], state["minds"][fid]
        grow_urge(f, mind, keys, dopamine.get(fid, 0.0))
        st = launch_state(mind)
        value = max(1e-12, p["eth"] + sum(h["qty"] * prices.get(s, 0.0) for s, h in p["holdings"].items()))

        if "buzzed" in keys:
            own = [s for s in reversed(st["coins"]) if s in pools and live(pools[s])]
            bags = sorted((s for s, h in p["holdings"].items() if s in pools and live(pools[s])
                           and h["qty"] * prices.get(s, 0.0) / value >= SHILL_MIN_SHARE),
                          key=lambda s: -p["holdings"][s]["qty"] * prices.get(s, 0.0))
            sym = (own or bags or [None])[0]
            if sym:
                social.append({"fly_id": fid, "kind": "shill", "symbol": sym, "reach": reach(fid, True),
                               "detail": {"own": sym in st["coins"], "did": sorted(keys)}})

        if "jumped" in keys:
            sold = [t["symbol"] for t in traded.get(fid, []) if t["side"] in ("panic_sell", "dump") and t["symbol"] in pools]
            foes = [c["symbol"] for c in pools.values() if live(c) and c.get("creator") and c["creator"] != fid
                    and bonds.get(pair(fid, c["creator"])) in HOSTILE and not p["holdings"].get(c["symbol"])]
            sym = (sold or sorted(foes) or [None])[0]
            if sym:
                creator = pools[sym].get("creator")
                social.append({"fly_id": fid, "kind": "fud", "symbol": sym, "reach": reach(fid, True),
                               "detail": {"creator": creator, "bond": bonds.get(pair(fid, creator)) if creator else None,
                                          "did": sorted(keys)}})

        for t in traded.get(fid, []):
            if t["side"] in ("buyback", "dump"):
                social.append({"fly_id": fid, "kind": t["side"], "symbol": t["symbol"], "reach": reach(fid, True),
                               "detail": {"eth": round(t["eth"], 6)}})

        if launched >= LAUNCHES_PER_ROUND or budget <= 0 or live_count >= LIVE_CAP or not wants_launch(mind, p, rng):
            continue
        coin, trade, event = launch_coin(f, mind, p, coins, prices, rng, now_iso, state.get("image"), sorted(keys), reach(fid, True))
        pools[coin["symbol"]] = coin
        launched += 1
        budget -= 1
        live_count += 1
        launch_trades.append(trade)
        social.append(event)
    state["launch_budget"] = budget
    return social, launch_trades


def launch_coin(fly: dict, mind: dict, portfolio: dict, coins: list[dict], prices: dict, rng: random.Random, now_iso: str,
                image=None, did: list[str] | None = None, reach: int = 0) -> tuple[dict, dict, dict]:
    """Launch one coin for this fly now: name and tagline from its personality, a logo (image(fly, symbol, persona)),
    a pool seeded with SEED_ETH and the creator's bag. Mutates mind, portfolio, coins and prices.
    Returns (coin row, launch trade row, social event). Used by each market round and by launch_now.py."""
    st = launch_state(mind)
    key = persona(fly, mind)
    theme = THEMES[key]
    noun = rng.choice(theme["nouns"])
    sym = symbol_for(fly["name"], noun, {c["symbol"] for c in coins})
    start_price = SEED_ETH / (SUPPLY * (1 - CREATOR_SHARE))
    coin = {"symbol": sym, "name": f"{fly['name']} {noun}"[:40], "kind": "fly", "price": start_price, "regime": "calm",
            "creator": fly["id"], "persona": key, "tagline": rng.choice(theme["taglines"]), "launched_at": now_iso,
            "launch_price": start_price, "supply": SUPPLY, "pool_eth": SEED_ETH, "pool_tokens": SUPPLY * (1 - CREATOR_SHARE),
            "status": "live"}
    logo = image(fly, sym, key) if image else {"image_path": None, "image_model": None, "image_cost": None}
    coin.update(logo)
    coins.append(coin)
    prices[sym] = start_price
    portfolio["eth"] -= SEED_ETH
    mine = SUPPLY * CREATOR_SHARE
    portfolio["holdings"][sym] = {"qty": mine, "cost_eth": SEED_ETH}
    portfolio["value_eth"] = portfolio["eth"] + sum(h["qty"] * prices.get(s, 0.0) for s, h in portfolio["holdings"].items())
    st["coins"].append(sym)
    st["last_round"] = st["rounds"]
    st["urge"] = 0.0
    trade = {"symbol": sym, "side": "launch", "qty": mine, "price": start_price, "eth": SEED_ETH,
             "fly_id": fly["id"], "value_after": portfolio["value_eth"],
             "reason": {"persona": key, "tagline": coin["tagline"], "did": did or [], "coin_number": len(st["coins"])}}
    event = {"fly_id": fly["id"], "kind": "launch", "symbol": sym, "reach": reach,
             "detail": {"persona": key, "tagline": coin["tagline"], "number": len(st["coins"])}}
    print(f"coin launch: {fly['name']} launched ${sym} ({coin['name']}, {key}, coin {len(st['coins'])}), "
          f"image {logo.get('image_model')} ${logo.get('image_cost')}", flush=True)
    return coin, trade, event
