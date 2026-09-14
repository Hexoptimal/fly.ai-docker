"""Flybook API: signed-in people create flies and play. Everything else is read straight from Supabase.

    python flybook/worker/api.py                 # listens on $PORT (8080)

    GET  /health
    GET  /config   token, chain, minimum balance, flies per holder and per free account (public)
    GET  /balance/<address>  a wallet's $FLYAI balance read on chain here, cached 60 s (public; for browsers
                             that can't reach the chain RPC, display only)
    GET  /me       wallet or email, handle, balance, holder, fly limit, your flies
                   (Authorization: Bearer <Supabase access token>)
    POST /handle   {handle}: your public name (needed by accounts without a wallet before they play)
    POST /flies    {name, color, patch_id, senses, temperament, dials}: creates a fly within your limit
    POST   /posts/<id>/like   like a post (only holders' likes count toward boards, missions and challenges)
    DELETE /posts/<id>/like   remove your like
    POST   /pokes             {patch_id, stimulus, x?, y?}: drop a real stimulus at a spot in a patch
    POST   /posts/<id>/caption  {body}: the fly's owner captions its post (shown as human)
    DELETE /posts/<id>/caption
    POST   /posts/<id>/comments {body}: comment on a post
    DELETE /comments/<id>       your own comment
    POST   /duels             {fly_id, opponent_id}: challenge any active fly with one of yours
    POST   /breed             {parent_a, parent_b, name, color, patch_id}: a child of your flies (or a house fly)

Accounts (2026-09-14): a session from Supabase's Web3 login (Sign in with Ethereum, so the wallet is proven by a
signature) or from an email magic link (a confirmed email). Holders ($FLYAI at or above the minimum, checked on
chain here) make up to FLYBOOK_MAX_FLIES flies; everyone else is a free account with settings.FREE_FLIES. Accounts
without a wallet pick a handle first, since email addresses are never shown. Only holders win season rewards.

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FLYBOOK_ORIGINS, FLYBOOK_MIN_TOKENS,
FLYBOOK_MAX_FLIES, ROBINHOOD_RPC, PORT.
"""
from __future__ import annotations

import json
import os
import random
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlparse

import requests

import chain
import settings as fly_settings
from duels import KINDS as DUEL_KINDS

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ORIGINS = {o.strip() for o in os.environ.get(
    "FLYBOOK_ORIGINS", "https://flyaiworld.com,https://www.flyaiworld.com,http://localhost:5173").split(",") if o.strip()}
MAX_FLIES = int(os.environ.get("FLYBOOK_MAX_FLIES", "3"))
FREE_FLIES = fly_settings.FREE_FLIES
FREE_FLIES_PER_IP_DAY = 3      # new flies from free accounts per network per day
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$")
HANDLE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
WALLET = re.compile(r"0x[0-9a-fA-F]{40}")
HTTP = requests.Session()
ADMIN = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def rest(method: str, path: str, prefer: str | None = None, conflict: str = "that name is taken", **kw):
    headers = {**ADMIN, **({"Prefer": prefer} if prefer else {})}
    r = HTTP.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=headers, timeout=20, **kw)
    if r.status_code == 409:
        raise ApiError(409, conflict)
    if not r.ok:
        raise ApiError(502, f"database error {r.status_code}")
    return r.json() if r.content else None


def wallet_of(user: dict) -> str | None:
    """The Ethereum address a Supabase Web3 sign-in attached to this user. Supabase stores it as
    identity_data.custom_claims.address and in sub ("web3:ethereum:0x..."), checked 2026-09-13."""
    for ident in user.get("identities") or []:
        if ident.get("provider") != "web3":
            continue
        data = ident.get("identity_data") or {}
        claims = data.get("custom_claims") or {}
        if claims.get("chain", "ethereum") != "ethereum":
            continue
        for value in (claims.get("address"), data.get("sub")):
            m = WALLET.search(str(value or ""))
            if m:
                return m.group(0).lower()
    return None


def email_of(user: dict) -> str | None:
    """A confirmed email (a magic-link sign-in confirms it)."""
    return user.get("email") if user.get("email") and user.get("email_confirmed_at") else None


def authed(handler: BaseHTTPRequestHandler) -> tuple[dict, str | None]:
    """The signed-in user and their proven wallet, or None for an email account."""
    auth = handler.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise ApiError(401, "sign in first")
    r = HTTP.get(f"{SUPABASE_URL}/auth/v1/user", headers={"apikey": SERVICE_KEY, "Authorization": auth}, timeout=15)
    if r.status_code != 200:
        raise ApiError(401, "your session expired, sign in again")
    user = r.json()
    wallet = wallet_of(user)
    if not wallet and not email_of(user):
        raise ApiError(403, "sign in with your wallet or a confirmed email")
    return user, wallet


def handle_of(user: dict) -> str | None:
    rows = rest("GET", f"profiles?select=handle&id=eq.{user['id']}")
    return rows[0]["handle"] if rows else None


def player(user: dict, wallet: str | None) -> str:
    """How this person is shown: a shortened wallet, else their handle. Accounts without a wallet must have one."""
    if wallet:
        return handle_of(user) or f"{wallet[:6]}…{wallet[-4:]}"
    handle = handle_of(user)
    if not handle:
        raise ApiError(403, "pick a name first")
    return handle


_hits: dict[str, list[float]] = {}
_lock = threading.Lock()
_holders: dict[str, tuple[float, bool]] = {}   # wallet -> (checked at, holder); likes reuse a recent check
HOLDER_TTL = 300.0


def limit(key: str, n: int, window: float, message: str = "slow down and try again in a minute") -> None:
    now = time.monotonic()
    with _lock:
        hits = [t for t in _hits.get(key, []) if now - t < window]
        if len(hits) >= n:
            raise ApiError(429, message)
        _hits[key] = hits + [now]


BALANCE_PATH = re.compile(r"^/balance/(0x[0-9a-fA-F]{40})$")
BALANCE_TTL = 60.0
_balances: dict[str, tuple[float, int]] = {}   # wallet -> (read at, balance)


def public_balance(wallet: str) -> dict:
    """A wallet's $FLYAI balance, read on chain here. For browsers whose own RPC read fails or hangs
    (some networks and extensions can't reach the chain RPC); display only, like the browser read."""
    wallet = wallet.lower()
    cached = _balances.get(wallet)
    if cached and time.monotonic() - cached[0] < BALANCE_TTL:
        balance = cached[1]
    else:
        try:
            balance = chain.balance_of(wallet)
        except Exception as e:
            raise ApiError(502, f"couldn't read the $FLYAI balance ({type(e).__name__}); try again") from e
        _balances[wallet] = (time.monotonic(), balance)
    return {"wallet": wallet, "balance": str(balance), "tokens": chain.tokens(balance), "holder": chain.is_holder(balance)}


def me(user: dict, wallet: str | None) -> dict:
    balance = 0
    if wallet:
        try:
            balance = chain.balance_of(wallet)
        except Exception as e:
            raise ApiError(502, f"couldn't read your $FLYAI balance ({type(e).__name__}); try again") from e
        _holders[wallet] = (time.monotonic(), chain.is_holder(balance))
    holder = bool(wallet) and chain.is_holder(balance)
    rest("POST", "profiles?on_conflict=id", "resolution=merge-duplicates",
         json={"id": user["id"], **({"wallet": wallet} if wallet else {})})
    flies = rest("GET", f"flies?select=id,name,color,patch_id,active,created_at,senses,temperament,dials,elo,wins,losses,draws,generation,parents,auto_born"
                         f"&owner=eq.{user['id']}&order=created_at")
    return {"wallet": wallet, "email": None if wallet else email_of(user), "handle": handle_of(user),
            "balance": str(balance), "tokens": chain.tokens(balance), "holder": holder,
            "min_tokens": float(chain.MIN_TOKENS), "max_flies": MAX_FLIES if holder else FREE_FLIES,
            "holder_max_flies": MAX_FLIES, "free_max_flies": FREE_FLIES, "flies": flies}


def set_handle(user: dict, wallet: str | None, body: dict) -> dict:
    handle = str(body.get("handle", "")).strip()
    if not HANDLE.match(handle) or handle.lower().startswith("0x"):
        raise ApiError(400, "names are 3-20 letters, digits or underscores, not starting with 0x")
    limit(f"handle:{user['id']}", 5, 3600, "you've changed your name a lot; try again later")
    rest("POST", "profiles?on_conflict=id", "resolution=merge-duplicates", conflict="that name is taken",
         json={"id": user["id"], "handle": handle, **({"wallet": wallet} if wallet else {})})
    return {"handle": handle}


def cap_message(info: dict) -> str:
    if info["holder"]:
        return f"you already have {MAX_FLIES} flies, the most per holder"
    return (f"free accounts make {FREE_FLIES} fly; hold " + f"{chain.MIN_TOKENS:f}".rstrip("0").rstrip(".")
            + f" $FLYAI to make up to {MAX_FLIES}")


def made_count(info: dict) -> int:
    """Flies that count toward the cap: ones you made or bred, not ones born from automatic mating."""
    return sum(1 for f in info["flies"] if not f.get("auto_born"))


def create_fly(user: dict, wallet: str | None, body: dict, ip: str) -> dict:
    limit(f"create:{user['id']}", 5, 60)
    name = str(body.get("name", "")).strip()
    color = str(body.get("color", ""))
    patch = str(body.get("patch_id", ""))
    if not NAME.match(name):
        raise ApiError(400, "names are 1-40 letters, digits, spaces, dots, dashes or underscores")
    if not COLOR.match(color):
        raise ApiError(400, "colour must look like #e0342c")
    if not rest("GET", f"patches?select=id&id=eq.{quote(patch)}"):
        raise ApiError(400, "that patch doesn't exist")
    try:
        tuned = fly_settings.clean(body, strict=True)
    except ValueError as e:
        raise ApiError(400, str(e))
    info = me(user, wallet)
    player(user, wallet)
    if made_count(info) >= info["max_flies"]:
        raise ApiError(403, cap_message(info))
    if not info["holder"]:
        limit(f"free-fly-ip:{ip}", FREE_FLIES_PER_IP_DAY, 86400, "too many new free flies from this network today")
    return rest("POST", "flies", "return=representation", json={
        "owner": user["id"], "name": name, "color": color, "patch_id": patch, "seed": random.randrange(2**31),
        "x": round(random.uniform(0.3, 0.7), 3), "y": round(random.uniform(0.3, 0.7), 3),
        "heading": round(random.uniform(0, 6.283), 2),
        **tuned})[0]


def is_holder(wallet: str | None) -> bool:
    if not wallet:
        return False
    checked = _holders.get(wallet)
    if checked and time.monotonic() - checked[0] < HOLDER_TTL:
        return checked[1]
    try:
        holder = chain.is_holder(chain.balance_of(wallet))
    except Exception as e:
        raise ApiError(502, f"couldn't read your $FLYAI balance ({type(e).__name__}); try again") from e
    _holders[wallet] = (time.monotonic(), holder)
    return holder


def count_likes(post_id: int) -> int:
    r = HTTP.head(f"{SUPABASE_URL}/rest/v1/likes?post_id=eq.{post_id}&select=post_id",
                  headers={**ADMIN, "Prefer": "count=exact"}, timeout=20)
    if not r.ok:
        raise ApiError(502, f"database error {r.status_code}")
    return int(r.headers.get("Content-Range", "*/0").split("/")[-1])


def set_like(user: dict, wallet: str | None, post_id: int, liked: bool) -> dict:
    """Anyone signed in likes posts; `by_holder` records whether the like counts toward boards and missions."""
    limit(f"like:{user['id']}", 60, 60)
    found = rest("GET", f"posts?select=id,flies(owner)&id=eq.{post_id}")
    if not found:
        raise ApiError(404, "that post doesn't exist")
    if liked:
        if (found[0].get("flies") or {}).get("owner") == user["id"]:
            raise ApiError(403, "you can't like your own fly's posts")
        player(user, wallet)
        rest("POST", "likes?on_conflict=post_id,user_id", "resolution=ignore-duplicates",
             json={"post_id": post_id, "user_id": user["id"], "by_holder": is_holder(wallet)})
    else:
        rest("DELETE", f"likes?post_id=eq.{post_id}&user_id=eq.{user['id']}")
    return {"post_id": post_id, "liked": liked, "likes": count_likes(post_id)}


POKE_STIMULI = ("threat", "mate", "wind", "taste", "touch", "cva")
POKE_EVERY = 120      # seconds between pokes per user
POKES_WAITING = 3     # pending pokes allowed per patch


def poke(user: dict, wallet: str | None, body: dict) -> dict:
    """Queue a stimulus for every fly in a patch. The worker applies it on its next pass."""
    patch = str(body.get("patch_id", ""))
    stimulus = str(body.get("stimulus", ""))
    if stimulus not in POKE_STIMULI:
        raise ApiError(400, f"stimulus must be one of {', '.join(POKE_STIMULI)}")
    if not rest("GET", f"patches?select=id&id=eq.{quote(patch)}"):
        raise ApiError(400, "that patch doesn't exist")
    player(user, wallet)
    spot = {}
    if body.get("x") is not None or body.get("y") is not None:
        try:
            x, y = float(body.get("x")), float(body.get("y"))
        except (TypeError, ValueError):
            raise ApiError(400, "x and y must be numbers between 0 and 1")
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise ApiError(400, "x and y must be numbers between 0 and 1")
        spot = {"x": round(x, 3), "y": round(y, 3)}
    waiting = rest("GET", f"pokes?select=id&patch_id=eq.{quote(patch)}&consumed_at=is.null")
    if len(waiting) >= POKES_WAITING:
        raise ApiError(429, f"this patch already has {POKES_WAITING} pokes waiting; try another patch")
    limit(f"poke:{user['id']}", 1, POKE_EVERY, f"one poke every {POKE_EVERY // 60} minutes")
    return rest("POST", "pokes", "return=representation",
                json={"patch_id": patch, "stimulus": stimulus, "user_id": user["id"], **spot})[0]


TEXT_MAX = 280


def text_body(body: dict) -> str:
    text = " ".join(str(body.get("body", "")).split())
    if not 1 <= len(text) <= TEXT_MAX:
        raise ApiError(400, f"write 1 to {TEXT_MAX} characters")
    return text


def post_owner(post_id: int) -> str | None:
    found = rest("GET", f"posts?select=id,flies(owner)&id=eq.{post_id}")
    if not found:
        raise ApiError(404, "that post doesn't exist")
    return (found[0].get("flies") or {}).get("owner")


def set_caption(user: dict, wallet: str | None, post_id: int, body: dict | None) -> dict:
    """The owner of the fly that made the post writes (or removes) one caption for it."""
    if post_owner(post_id) != user["id"]:
        raise ApiError(403, "only the fly's owner can caption its posts")
    if body is None:
        rest("DELETE", f"captions?post_id=eq.{post_id}")
        return {"post_id": post_id, "caption": None}
    player(user, wallet)
    limit(f"caption:{user['id']}", 20, 600, "that's a lot of captions; try again in a few minutes")
    row = {"post_id": post_id, "author": user["id"], "body": text_body(body)}
    rest("POST", "captions?on_conflict=post_id", "resolution=merge-duplicates", json=row)
    return {"post_id": post_id, "caption": row["body"]}


def add_comment(user: dict, wallet: str | None, post_id: int, body: dict) -> dict:
    post_owner(post_id)
    who = player(user, wallet)
    limit(f"comment-burst:{user['id']}", 1, 10, "one comment every 10 seconds")
    limit(f"comment-hour:{user['id']}", 30, 3600, "30 comments an hour is the limit")
    # the column keeps its old name; it holds how the commenter is shown (shortened wallet or handle)
    return rest("POST", "comments", "return=representation",
                json={"post_id": post_id, "user_id": user["id"], "wallet_short": who, "body": text_body(body)})[0]


def delete_comment(user: dict, comment_id: int) -> dict:
    found = rest("GET", f"comments?select=id,user_id&id=eq.{comment_id}")
    if not found:
        raise ApiError(404, "that comment doesn't exist")
    if found[0]["user_id"] != user["id"]:
        raise ApiError(403, "you can only delete your own comments")
    rest("DELETE", f"comments?id=eq.{comment_id}")
    return {"deleted": comment_id}


def challenge(user: dict, wallet: str | None, body: dict) -> dict:
    """Challenge any active fly to a duel with one of your own. The worker fights it within seconds."""
    mine, other = str(body.get("fly_id", "")), str(body.get("opponent_id", ""))
    if mine == other:
        raise ApiError(400, "a fly can't duel itself")
    rows = rest("GET", f"flies?select=id,owner,active&id=in.({quote(mine)},{quote(other)})")
    by_id = {r["id"]: r for r in rows}
    if mine not in by_id or other not in by_id:
        raise ApiError(404, "one of those flies doesn't exist")
    if by_id[mine]["owner"] != user["id"]:
        raise ApiError(403, "challenge with one of your own flies")
    if not by_id[mine]["active"] or not by_id[other]["active"]:
        raise ApiError(400, "dormant flies can't duel")
    player(user, wallet)
    if rest("GET", f"duels?select=id&status=eq.pending&or=(a_fly.eq.{mine},b_fly.eq.{mine})"):
        raise ApiError(429, "your fly already has a duel waiting")
    limit(f"duel:{user['id']}", 1, 60, "one challenge a minute")
    return rest("POST", "duels", "return=representation", json={
        "kind": random.choice(DUEL_KINDS), "a_fly": mine, "b_fly": other, "requested_by": user["id"]})[0]


def breed(user: dict, wallet: str | None, body: dict) -> dict:
    """A new fly from two parents: your own flies, or one of yours with a house fly."""
    a_id, b_id = str(body.get("parent_a", "")), str(body.get("parent_b", ""))
    if a_id == b_id:
        raise ApiError(400, "pick two different parents")
    parents = rest("GET", f"flies?select=id,owner,senses,temperament,dials,generation&id=in.({quote(a_id)},{quote(b_id)})")
    if len(parents) != 2:
        raise ApiError(404, "one of those flies doesn't exist")
    if any(p["owner"] not in (None, user["id"]) for p in parents) or all(p["owner"] is None for p in parents):
        raise ApiError(403, "breed your own flies, or one of yours with a house fly")
    name = str(body.get("name", "")).strip()
    color = str(body.get("color", ""))
    patch = str(body.get("patch_id", ""))
    if not NAME.match(name):
        raise ApiError(400, "names are 1-40 letters, digits, spaces, dots, dashes or underscores")
    if not COLOR.match(color):
        raise ApiError(400, "colour must look like #e0342c")
    if not rest("GET", f"patches?select=id&id=eq.{quote(patch)}"):
        raise ApiError(400, "that patch doesn't exist")
    info = me(user, wallet)
    player(user, wallet)
    if made_count(info) >= info["max_flies"]:
        raise ApiError(403, cap_message(info))
    limit(f"breed:{user['id']}", 3, 3600, "three hatchings an hour is the limit")
    by_id = {p["id"]: p for p in parents}
    child = fly_settings.breed(by_id[a_id], by_id[b_id], random.Random())
    return rest("POST", "flies", "return=representation", json={
        "owner": user["id"], "name": name, "color": color, "patch_id": patch, "seed": random.randrange(2**31),
        "x": round(random.uniform(0.3, 0.7), 3), "y": round(random.uniform(0.3, 0.7), 3),
        "heading": round(random.uniform(0, 6.283), 2), "parents": [a_id, b_id],
        "generation": max(p.get("generation") or 1 for p in parents) + 1, **child})[0]


CAPTION_PATH = re.compile(r"^/posts/(\d+)/caption$")
COMMENTS_PATH = re.compile(r"^/posts/(\d+)/comments$")
COMMENT_PATH = re.compile(r"^/comments/(\d+)$")
LIKE_PATH = re.compile(r"^/posts/(\d+)/like$")


class Handler(BaseHTTPRequestHandler):
    server_version = "flybook"

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _send(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 4096:
            raise ApiError(413, "request too large")
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "body must be JSON")
        if not isinstance(body, dict):
            raise ApiError(400, "body must be a JSON object")
        return body

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_DELETE(self) -> None:
        self._handle("DELETE")

    def _handle(self, method: str) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        ip = self.headers.get("Fly-Client-IP") or self.client_address[0]
        try:
            limit(f"ip:{ip}", 60, 60)
            if method == "GET" and path == "/health":
                return self._send(200, {"ok": True})
            if method == "GET" and path == "/config":
                return self._send(200, {"token": chain.TOKEN, "chain_id": chain.CHAIN_ID,
                                        "min_tokens": float(chain.MIN_TOKENS), "max_flies": MAX_FLIES,
                                        "free_max_flies": FREE_FLIES, "settings": fly_settings.public_spec()})
            balance_match = BALANCE_PATH.match(path)
            if method == "GET" and balance_match:
                limit(f"balance:{ip}", 20, 60)
                return self._send(200, public_balance(balance_match.group(1)))
            if method == "GET" and path == "/me":
                return self._send(200, me(*authed(self)))
            if method == "POST" and path == "/handle":
                user, wallet = authed(self)
                return self._send(200, set_handle(user, wallet, self._body()))
            if method == "POST" and path == "/flies":
                user, wallet = authed(self)
                return self._send(201, create_fly(user, wallet, self._body(), ip))
            if method == "POST" and path == "/pokes":
                user, wallet = authed(self)
                return self._send(201, poke(user, wallet, self._body()))
            if method == "POST" and path == "/duels":
                user, wallet = authed(self)
                return self._send(201, challenge(user, wallet, self._body()))
            if method == "POST" and path == "/breed":
                user, wallet = authed(self)
                return self._send(201, breed(user, wallet, self._body()))
            caption = CAPTION_PATH.match(path)
            if caption and method in ("POST", "DELETE"):
                user, wallet = authed(self)
                return self._send(200, set_caption(user, wallet, int(caption.group(1)), self._body() if method == "POST" else None))
            comments = COMMENTS_PATH.match(path)
            if comments and method == "POST":
                user, wallet = authed(self)
                return self._send(201, add_comment(user, wallet, int(comments.group(1)), self._body()))
            comment = COMMENT_PATH.match(path)
            if comment and method == "DELETE":
                user, _ = authed(self)
                return self._send(200, delete_comment(user, int(comment.group(1))))
            like = LIKE_PATH.match(path)
            if like and method in ("POST", "DELETE"):
                user, wallet = authed(self)
                return self._send(200, set_like(user, wallet, int(like.group(1)), method == "POST"))
            raise ApiError(404, "not found")
        except ApiError as e:
            self._send(e.status, {"error": str(e)})
        except Exception as e:
            self.log_error("unhandled %r", e)
            self._send(500, {"error": "server error"})


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    print(f"flybook api on :{port}, origins {sorted(ORIGINS)}, min {chain.MIN_TOKENS} $FLYAI, {MAX_FLIES} flies per holder, "
          f"{FREE_FLIES} per free account", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
