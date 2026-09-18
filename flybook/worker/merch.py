"""Fly merch: a $FLYAI holder draws a design of their fly, pays a small $FLYAI fee, and it goes on sale as print-on-demand
products in the "Fly Merch" collection of shop.flyaiworld.com (Fourthwall). Owners earn a share of each sale's profit.

    draw     the API (POST /merch/designs) asks the image model for the fly (memes.generate), cuts it into a round badge
             with the fly's name on a banner (stamped by us, not the model), and stores a print PNG and a preview.
    pay      the owner sends FEE $FLYAI to TREASURY on Robinhood Chain; the API checks the transfer on chain
             (chain.paid) and marks the design paid.
    make     this worker uploads the print PNG to Fourthwall and creates one product per PRODUCTS entry (Fourthwall
             renders the mockups), then adds them to the Fly Merch collection. Each product is saved as soon as it
             exists, so a retry only makes the missing ones.
    sales    this worker reads the shop's orders (updated since its cursor) and records every line of a fly product:
             profit = (unit price - unit cost) x quantity, owner cut = profit x SHARE.
    payouts  by hand: `payouts` lists what each owner is owed, `paid` records a payout.

    python flybook/worker/merch.py run                 # the fly.io "merch" process: make products + sync orders
    python flybook/worker/merch.py sync                # sync orders once
    python flybook/worker/merch.py make [ID]           # make paid designs once (or retry one, even a failed one)
    python flybook/worker/merch.py remove ID           # archive a design's products and hide it
    python flybook/worker/merch.py payouts             # what each owner is owed
    python flybook/worker/merch.py paid OWNER --tx 0x.. [--tokens N] [--note ..]   # record a payout of all they're owed

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FOURTHWALL_USER, FOURTHWALL_PASSWORD, OPENROUTER_API_KEY (drawing),
FLYBOOK_MERCH_FEE, FLYBOOK_MERCH_TREASURY, FLYBOOK_MERCH_SHARE, FLYBOOK_MERCH_PUBLISH.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import os
import random
import sys
import time
from decimal import Decimal
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont

import chain
import memes

FEE_TOKENS = Decimal(os.environ.get("FLYBOOK_MERCH_FEE", "50000"))          # $FLYAI per design
FEE_WEI = int(FEE_TOKENS * 10**chain.DECIMALS)
TREASURY = os.environ.get("FLYBOOK_MERCH_TREASURY", "0x625862521777E19Ad54Ce6C7ABeD9Ca54D6589ea").lower()   # dev wallet
SHARE = float(os.environ.get("FLYBOOK_MERCH_SHARE", "0.4"))                 # the owner's share of each sale's profit
PUBLISH = os.environ.get("FLYBOOK_MERCH_PUBLISH", "1") == "1"               # 0: products stay hidden until published by hand
DRAFTS_PER_DAY = 3                 # designs drawn per person per UTC day (each costs an image)
DAILY_CAP = int(os.environ.get("FLYBOOK_MERCH_DAILY_CAP", "40"))           # designs drawn per UTC day, everyone together
MAX_ATTEMPTS = 3                   # the worker gives up on a design after this many failed makes
PAYABLE_AFTER_DAYS = 30            # sales count toward a payout once shipped, or this old (returns window)
SHOP = "https://shop.flyaiworld.com"
COLLECTION_NAME = "Fly Merch"
COLLECTION_ABOUT = "Designed by Flybook flies and their owners. Every fly is a simulated fruit fly brain; owners earn from every sale."
FW = "https://api.fourthwall.com/open-api/v1.0"
FONT = Path(__file__).resolve().parent / "fonts" / "Anton-Regular.ttf"
PRINT = 2250                       # print canvas, px (15" at 150 dpi on a tee's large front)
PREVIEW = 640

# Fourthwall product templates (checked 2026-09-18 with GET /product-templates). margin = our profit per item in USD
# on top of Fourthwall's base cost; the shop price is base + margin.
PRODUCTS = [
    {"kind": "tee", "label": "Tee", "template": "pro_e4677535402b4eeb81", "region": "front_large", "placement": "largeCenter",
     "colors": ["Black", "Navy", "Charcoal", "White"], "margin": 12.0, "noun": "Tee"},
    {"kind": "hoodie", "label": "Hoodie", "template": "pro_380", "region": "front", "placement": "largeCenter",
     "colors": ["Black", "Navy Blazer", "Charcoal Heather"], "margin": 18.0, "noun": "Hoodie"},
    {"kind": "mug", "label": "Mug", "template": "pro_dWMJDO04TgWcXKGQohVnHw", "region": "default",
     "colors": None, "margin": 8.0, "noun": "Mug"},
    {"kind": "sticker", "label": "Sticker", "template": "pro_358", "region": "default",
     "colors": None, "margin": 3.0, "noun": "Sticker"},
]

STYLES = {
    "sticker": ("Sticker", "a bold flat vector sticker illustration with thick clean outlines and bright flat colours"),
    "retro": ("Retro", "a 1970s retro illustration with a warm striped sunset and a slightly grainy vintage print look"),
    "street": ("Streetwear", "an edgy streetwear graffiti illustration with spray-paint texture, drips and bold shading"),
    "kawaii": ("Kawaii", "an adorable kawaii chibi illustration with soft pastel colours and little sparkles"),
    "pixel": ("Pixel art", "a crisp 32-bit pixel art illustration with a limited colour palette"),
    "tattoo": ("Tattoo flash", "an American traditional tattoo flash illustration with bold black outlines and limited red, yellow and green"),
}
MOTIF = {   # the fly's market personality (launches.persona), when the owner gives no idea
    "degen": "riding a tiny rocket trailing sparks",
    "jumpy": "mid-jump with motion lines and wide startled eyes",
    "chill": "relaxing on a slice of banana with a tiny drink",
    "watcher": "peering through a tiny telescope",
    "normie": "proudly holding a tiny slice of fruit",
}


class MerchError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise MerchError(503, "merch isn't switched on yet")
    return value


# ---- the database (service role) ----

def db(method: str, path: str, prefer: str | None = None, **kw):
    url, key = env("SUPABASE_URL").rstrip("/"), env("SUPABASE_SERVICE_ROLE_KEY")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
               **({"Prefer": prefer} if prefer else {})}
    r = requests.request(method, f"{url}/rest/v1/{path}", headers=headers, timeout=30, **kw)
    if not r.ok:
        raise RuntimeError(f"database {method} {path.split('?')[0]}: {r.status_code} {r.text[:200]}")
    return r.json() if r.content else None


def public_url(path: str) -> str:
    return f"{env('SUPABASE_URL').rstrip('/')}/storage/v1/object/public/merch/{path}"


def store(path: str, data: bytes, content_type: str) -> None:
    url, key = env("SUPABASE_URL").rstrip("/"), env("SUPABASE_SERVICE_ROLE_KEY")
    r = requests.post(f"{url}/storage/v1/object/merch/{path}", data=data, timeout=120, headers={
        "Authorization": f"Bearer {key}", "apikey": key, "Content-Type": content_type,
        "cache-control": "31536000", "x-upsert": "false"})
    if not r.ok:
        raise MerchError(502, f"couldn't save the design ({r.status_code}); try again")


def unstore(*paths: str) -> None:
    url, key = env("SUPABASE_URL").rstrip("/"), env("SUPABASE_SERVICE_ROLE_KEY")
    requests.delete(f"{url}/storage/v1/object/merch", timeout=30, json={"prefixes": list(paths)},
                    headers={"Authorization": f"Bearer {key}", "apikey": key})


def state(key: str) -> str | None:
    rows = db("GET", f"merch_state?select=value&key=eq.{key}")
    return rows[0]["value"] if rows else None


def set_state(key: str, value: str) -> None:
    db("POST", "merch_state?on_conflict=key", "resolution=merge-duplicates",
       json={"key": key, "value": value, "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()})


# ---- drawing a design ----

def personality(fly: dict) -> str:
    try:
        import launches
        minds = db("GET", f"fly_minds?select=traits&fly_id=eq.{fly['id']}")
        return launches.persona(fly, minds[0] if minds else {})
    except Exception:
        return "normie"


def prompt(fly: dict, style: str, idea: str | None) -> str:
    what = f"in this scene: {idea}" if idea else MOTIF[personality(fly)]
    return (f"{STYLES[style][1]}. A cute cartoon fruit fly character (a fruit fly, not a bee: slim body, no stripes, "
            f"no stinger) with a {memes.color_name(fly.get('color', ''))} body, big round glossy red compound eyes, two "
            f"short antennae and clear wings, {what}. A full-bleed square illustration: the fly is large and centred and "
            "its colourful background fills the image to every edge, with no border, frame, circle, badge or vignette. "
            "No text, no letters, no numbers, no logos, no watermark, no real people.")


def _font(text: str, width: int, start: int) -> ImageFont.FreeTypeFont:
    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    for size in range(start, 60, -8):
        font = ImageFont.truetype(str(FONT), size)
        if probe.textlength(text, font=font) <= width:
            return font
    return ImageFont.truetype(str(FONT), 60)


def compose(art: bytes, name: str | None, color: str) -> tuple[bytes, bytes]:
    """The print PNG (PRINT x PRINT, transparent outside the badge) and a WebP preview. The badge is the art cut into
    a circle with a white and black rim; the fly's name sits on a banner across the bottom of it."""
    size = PRINT
    radius = int(size * 0.40)
    black, white = int(radius * 0.06), int(radius * 0.035)
    cx = size // 2
    cy = radius + white + black + size // 50 if name else size // 2   # room for the name banner below
    img = Image.open(io.BytesIO(art)).convert("RGB")
    side = int(min(img.size) * 0.94)   # trim the edges, where models like to leave a border
    img = img.crop(((img.width - side) // 2, (img.height - side) // 2, (img.width + side) // 2, (img.height + side) // 2))
    img = img.resize((2 * radius, 2 * radius), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    def disc(r: int) -> Image.Image:
        """A circle mask drawn at 2x and scaled down, for a smooth edge."""
        m = Image.new("L", (size * 2, size * 2), 0)
        ImageDraw.Draw(m).ellipse(((cx - r) * 2, (cy - r) * 2, (cx + r) * 2, (cy + r) * 2), fill=255)
        return m.resize((size, size), Image.LANCZOS)

    canvas.paste((17, 17, 17, 255), (0, 0), disc(radius + white + black))
    canvas.paste((255, 255, 255, 255), (0, 0), disc(radius + white))
    art_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    art_layer.paste(img, (cx - radius, cy - radius))
    canvas.paste(art_layer, (0, 0), disc(radius))

    if name:
        text = name.upper()
        font = _font(text, int(size * 0.70), int(size * 0.12))
        draw = ImageDraw.Draw(canvas)
        tw = draw.textlength(text, font=font)
        pad_x, h = int(font.size * 0.55), int(font.size * 1.35)
        w = int(tw + 2 * pad_x)
        top = cy + radius - int(h * 0.55)
        box = (cx - w // 2, top, cx + w // 2, top + h)
        try:
            rgb = tuple(int(color.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            rgb = (224, 52, 44)
        draw.rounded_rectangle(box, radius=h // 3, fill=(17, 17, 17, 255), outline=(*rgb, 255), width=max(8, h // 12))
        draw.text((cx - tw / 2, top + (h - font.size) / 2 - font.size * 0.08), text, font=font, fill=(255, 255, 255, 255))

    bbox = canvas.getbbox() or (0, 0, size, size)
    pad = int(size * 0.02)
    canvas = canvas.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(size, bbox[2] + pad), min(size, bbox[3] + pad)))
    out = io.BytesIO()
    canvas.save(out, "PNG", optimize=True)
    prev = canvas.copy()
    prev.thumbnail((PREVIEW, PREVIEW), Image.LANCZOS)
    small = io.BytesIO()
    prev.save(small, "WEBP", quality=85, method=5)
    return out.getvalue(), small.getvalue()


def name_ok(name: str) -> bool:
    """Whether the fly's name may be printed: the meme idea checks (no brands, real people, famous characters)."""
    try:
        memes.clean_idea(name)
        memes.check_idea(name)
        return True
    except memes.MemeError:
        return False


def draw_design(user_id: str, fly: dict, style: str, idea: str | None, show_name: bool) -> dict:
    """Draw a design for this fly and save it as a draft. Checks are the caller's (api.py)."""
    printed_name = fly["name"] if show_name and name_ok(fly["name"]) else None
    try:
        art, cost = memes.generate(prompt(fly, style, idea))
    except memes.MemeError as e:
        raise MerchError(e.status, str(e))
    png, preview = compose(art, printed_name, fly.get("color", ""))
    stem = f"{fly['id']}/{int(time.time())}-{random.randrange(16**6):06x}"
    store(f"{stem}.png", png, "image/png")
    store(f"{stem}.webp", preview, "image/webp")
    row = db("POST", "merch_designs", "return=representation", json={
        "user_id": user_id, "fly_id": fly["id"], "style": style, "idea": idea, "print_path": f"{stem}.png",
        "preview_path": f"{stem}.webp", "model": memes.IMAGE_MODEL, "cost": cost})[0]
    return {**row, "preview_url": public_url(row["preview_path"]), "name_printed": printed_name is not None}


# ---- Fourthwall ----

def fw(method: str, path: str, **kw):
    auth = (env("FOURTHWALL_USER"), env("FOURTHWALL_PASSWORD"))
    for attempt in range(6):
        r = requests.request(method, f"{FW}/{path}", auth=auth, timeout=180, **kw)
        if r.status_code == 429 and attempt < 5:      # product creation is 5 a minute per shop
            time.sleep(float(r.headers.get("Retry-After") or 15))
            continue
        if not r.ok:
            raise RuntimeError(f"fourthwall {method} {path}: {r.status_code} {r.text[:300]}")
        return r.json() if r.content else None


def upload_image(png: bytes, name: str) -> str:
    """Upload a PNG to the shop's media library; returns its imageId."""
    up = fw("POST", "media/upload-url", json={"fileName": name, "contentType": "image/png", "size": len(png)})
    r = requests.put(up["uploadUrl"], data=png, timeout=180,
                     headers={"Content-Type": "image/png", "x-goog-content-length-range": f"0,{len(png)}"})
    if not r.ok:
        raise RuntimeError(f"media upload: {r.status_code} {r.text[:200]}")
    w, h = Image.open(io.BytesIO(png)).size
    return fw("POST", "media/images", json={"fileUrl": up["fileUrl"], "width": w, "height": h})["id"]


def collection_id(first_offers: list[str]) -> str:
    """The Fly Merch collection: remembered in merch_state, found by name, or created with these products."""
    known = state("collection_id")
    if known:
        return known
    for c in fw("GET", "collections?size=100").get("results", []):
        if c.get("name") == COLLECTION_NAME:
            set_state("collection_id", c["id"])
            return c["id"]
    made = fw("POST", "collections", json={"name": COLLECTION_NAME, "description": COLLECTION_ABOUT, "offerIds": first_offers})
    set_state("collection_id", made["id"])
    return made["id"]


def add_to_collection(offers: list[str]) -> None:
    cid = collection_id(offers)
    have, page = [], 0
    while True:
        got = fw("GET", f"collections/{cid}/products?page={page}&size=100")
        items = got.get("results", got if isinstance(got, list) else [])
        have += [p["id"] for p in items]
        if isinstance(got, list) or page + 1 >= got.get("totalPages", 1):
            break
        page += 1
    missing = [o for o in offers if o not in have]
    if missing:
        fw("PUT", f"collections/{cid}/products", json={"offerIds": missing + have})


def region(spec: dict, image_id: str) -> dict:
    """Where the design goes: a named placement (a tee's large centre print), else Fourthwall's default."""
    if spec.get("placement"):
        return {"region": spec["region"], "imageId": image_id, "placementStrategy": "PLACEMENT_ID", "placementId": spec["placement"]}
    return {"region": spec["region"], "imageId": image_id, "placementStrategy": "AUTO"}


def make(design: dict) -> None:
    """Create the design's missing products on Fourthwall, put them in the collection, and mark it live."""
    fly = (db("GET", f"flies?select=id,name&id=eq.{design['fly_id']}") or [{"name": "A fly"}])[0]
    db("PATCH", f"merch_designs?id=eq.{design['id']}", json={"status": "making", "attempts": design.get("attempts", 0) + 1})
    done = {p["kind"] for p in db("GET", f"merch_products?select=kind&design_id=eq.{design['id']}")}
    todo = [p for p in PRODUCTS if p["kind"] not in done]
    if todo:
        png = requests.get(public_url(design["print_path"]), timeout=120)
        png.raise_for_status()
        image_id = upload_image(png.content, f"flybook-{design['id']}.png")
    for spec in todo:
        body = {"type": "design", "productTemplateId": spec["template"], "name": f"{fly['name']} {spec['noun']}",
                "description": (f"{fly['name']} is a fruit fly on Flybook, flyaiworld.com/flybook: a simulated fly brain "
                                f"that posts, duels and trades. Its owner designed this. Art made with AI."),
                "regions": [region(spec, image_id)],
                "profitMargin": spec["margin"], "publishOnCreate": PUBLISH}
        if spec["colors"]:
            body["colors"] = spec["colors"]
        made = fw("POST", "products", json=body)
        product = fw("GET", f"products/{made['productId']}")
        prices = [v["unitPrice"]["value"] for v in product.get("variants", []) if v.get("unitPrice")]
        mockup = next((i["url"] for i in made.get("images", []) if i.get("url")), None)
        db("POST", "merch_products", json={
            "design_id": design["id"], "kind": spec["kind"], "fourthwall_id": made["productId"], "slug": product.get("slug"),
            "url": f"{SHOP}/products/{product.get('slug')}" if product.get("slug") else SHOP,
            "image_url": mockup, "price": min(prices) if prices else None, "margin": spec["margin"]})
        print(f"merch {design['id']}: {spec['kind']} {made['productId']}", flush=True)
    offers = [p["fourthwall_id"] for p in db("GET", f"merch_products?select=fourthwall_id&design_id=eq.{design['id']}")]
    add_to_collection(offers)
    db("PATCH", f"merch_designs?id=eq.{design['id']}", json={
        "status": "live", "live_at": dt.datetime.now(dt.timezone.utc).isoformat(), "error": None})


def make_pending(only: int | None = None) -> None:
    where = f"id=eq.{only}" if only else "status=in.(paid,making)"
    for design in db("GET", f"merch_designs?select=*&{where}&order=paid_at"):
        if not design.get("tx_hash"):
            continue
        try:
            make(design)
        except Exception as e:
            attempts = design.get("attempts", 0) + 1
            status = "failed" if attempts >= MAX_ATTEMPTS and not only else "paid"
            print(f"merch {design['id']} attempt {attempts} failed: {e}", flush=True)
            db("PATCH", f"merch_designs?id=eq.{design['id']}", json={"status": status, "attempts": attempts, "error": str(e)[:500]})


def remove(design_id: int) -> None:
    for p in db("GET", f"merch_products?select=fourthwall_id&design_id=eq.{design_id}"):
        fw("DELETE", f"products/{p['fourthwall_id']}")
    db("PATCH", f"merch_designs?id=eq.{design_id}", json={"status": "removed"})


# ---- sales ----

def products_map() -> dict[str, dict]:
    rows = db("GET", "merch_products?select=fourthwall_id,design_id,margin,merch_designs(user_id)")
    return {r["fourthwall_id"]: {"design_id": r["design_id"], "margin": float(r["margin"]),
                                 "owner": (r.get("merch_designs") or {}).get("user_id")} for r in rows}


def sale_rows(order: dict, ours: dict[str, dict]) -> list[dict]:
    rows = []
    for offer in order.get("offers") or []:
        mine = ours.get(offer.get("id"))
        variant = offer.get("variant") or {}
        if not mine or not variant:
            continue
        qty = int(variant.get("quantity") or 0)
        price = float((variant.get("unitPrice") or variant.get("price") or {}).get("value") or 0)
        cost = (variant.get("unitCost") or {}).get("value")
        each = price - float(cost) if cost is not None else mine["margin"]
        profit = round(max(0.0, each) * qty, 2)
        rows.append({"order_id": order["id"], "variant_id": variant.get("id") or "", "fourthwall_id": offer["id"],
                     "design_id": mine["design_id"], "owner": mine["owner"], "quantity": qty, "unit_price": price,
                     "unit_cost": cost, "profit": profit, "share": SHARE, "owner_cut": round(profit * SHARE, 2),
                     "status": order.get("status") or "CONFIRMED", "ordered_at": order["createdAt"],
                     "updated_at": order.get("updatedAt") or order["createdAt"]})
    return rows


def sync_orders() -> int:
    """Record fly-product lines of orders updated since the cursor. Upserts, so re-reading an order is safe."""
    ours = products_map()
    if not ours:
        return 0
    since = state("orders_since") or "2026-09-18T00:00:00Z"
    newest, saved, page = since, 0, 0
    while True:
        got = fw("GET", "order", params={"updatedAt[gt]": since, "page": page, "size": 50})
        for order in got.get("results", []):
            newest = max(newest, order.get("updatedAt") or order.get("createdAt") or newest)
            rows = sale_rows(order, ours)
            if rows:
                db("POST", "merch_sales?on_conflict=order_id,variant_id,fourthwall_id", "resolution=merge-duplicates", json=rows)
                saved += len(rows)
        page += 1
        if page >= got.get("totalPages", 1):
            break
    if newest != since:
        # step back a minute: orders updated in the same second as the newest one are read again, not missed
        back = dt.datetime.fromisoformat(newest.replace("Z", "+00:00")) - dt.timedelta(minutes=1)
        set_state("orders_since", back.isoformat().replace("+00:00", "Z"))
    return saved


def payable(sale: dict) -> bool:
    if sale["status"] == "CANCELLED" or sale.get("payout_id"):
        return False
    if sale["status"] in ("SHIPPED", "PARTIALLY_DELIVERED", "DELIVERED", "COMPLETED"):
        return True
    ordered = dt.datetime.fromisoformat(sale["ordered_at"].replace("Z", "+00:00"))
    return dt.datetime.now(dt.timezone.utc) - ordered >= dt.timedelta(days=PAYABLE_AFTER_DAYS)


def owed() -> dict[str, dict]:
    by_owner: dict[str, dict] = {}
    for s in db("GET", "merch_sales?select=*&payout_id=is.null&status=neq.CANCELLED"):
        if not s.get("owner"):
            continue
        o = by_owner.setdefault(s["owner"], {"payable": 0.0, "pending": 0.0, "sales": []})
        if payable(s):
            o["payable"] += float(s["owner_cut"])
            o["sales"].append(s)
        else:
            o["pending"] += float(s["owner_cut"])
    return by_owner


def wallet_of(owner: str) -> str | None:
    rows = db("GET", f"profiles?select=wallet&id=eq.{owner}")
    return rows[0]["wallet"] if rows and rows[0].get("wallet") else None


def record_payout(owner: str, tx: str | None, tokens: float | None, note: str | None) -> None:
    due = owed().get(owner)
    if not due or not due["sales"]:
        raise SystemExit("nothing payable for that owner")
    wallet = wallet_of(owner)
    if not wallet:
        raise SystemExit("that owner has no wallet on their profile")
    payout = db("POST", "merch_payouts", "return=representation", json={
        "owner": owner, "wallet": wallet, "usd": round(due["payable"], 2), "tokens": tokens, "tx_hash": tx, "note": note})[0]
    for s in due["sales"]:
        db("PATCH", f"merch_sales?order_id=eq.{s['order_id']}&variant_id=eq.{requests.utils.quote(s['variant_id'])}"
                    f"&fourthwall_id=eq.{s['fourthwall_id']}", json={"payout_id": payout["id"]})
    print(f"payout {payout['id']}: ${payout['usd']} to {wallet}, {len(due['sales'])} sales", flush=True)


# ---- the worker ----

def run(make_every: float = 20, sync_every: float = 300) -> None:
    print(f"merch worker: fee {FEE_TOKENS} $FLYAI to {TREASURY}, owner share {SHARE:.0%}, publish {PUBLISH}", flush=True)
    next_sync = 0.0
    while True:
        try:
            make_pending()
        except Exception as e:
            print(f"make pass failed: {e}", flush=True)
        if time.monotonic() >= next_sync:
            next_sync = time.monotonic() + sync_every
            try:
                n = sync_orders()
                if n:
                    print(f"synced {n} sale lines", flush=True)
            except Exception as e:
                print(f"order sync failed: {e}", flush=True)
        time.sleep(make_every)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sub.add_parser("sync")
    m = sub.add_parser("make")
    m.add_argument("id", type=int, nargs="?")
    r = sub.add_parser("remove")
    r.add_argument("id", type=int)
    sub.add_parser("payouts")
    pd = sub.add_parser("paid")
    pd.add_argument("owner")
    pd.add_argument("--tx")
    pd.add_argument("--tokens", type=float)
    pd.add_argument("--note")
    args = p.parse_args()
    if args.cmd == "run":
        run()
    elif args.cmd == "sync":
        print(f"{sync_orders()} sale lines")
    elif args.cmd == "make":
        make_pending(args.id)
    elif args.cmd == "remove":
        remove(args.id)
    elif args.cmd == "payouts":
        rows = owed()
        if not rows:
            print("nobody is owed anything")
        for owner, o in sorted(rows.items(), key=lambda kv: -kv[1]["payable"]):
            print(f"{owner}  wallet {wallet_of(owner) or '-'}  payable ${o['payable']:.2f} ({len(o['sales'])} lines)  "
                  f"pending ${o['pending']:.2f}")
    elif args.cmd == "paid":
        record_payout(args.owner, args.tx, args.tokens, args.note)


if __name__ == "__main__":
    sys.exit(main())
