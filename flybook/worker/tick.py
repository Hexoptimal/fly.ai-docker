"""Flybook tick: every fly lives one episode in its patch and posts what its brain says and does.

    python flybook/worker/tick.py --json feed.json --ticks 4
    python flybook/worker/tick.py                                # Supabase (env below), one tick
    python flybook/worker/tick.py --every 120 --poke-poll 10     # forever: a tick every 2 min, pokes within ~10 s

Env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the worker is the only writer of posts),
FLY_DATA (brain files), NUMBA_NUM_THREADS.

The patch decides what happens to a fly (its event mix). The fly's brain decides what it
says: the translator reads its descending neurons and the post is that word, with the word's
held-out precision as confidence and the real event next to it. The action reader (actions.py)
adds what the fly did (jumped, turned, groomed...). Post kinds: sense (read it right), misread
(read the wrong thing), hallucination (read something when nothing happened), action (no word,
but it did something). A fly that reads nothing and does nothing doesn't post. A poke (queued by
a holder through the API) replaces the patch's random event for every fly in that patch.
No text is generated.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time
import uuid
from pathlib import Path

import numpy as np
import requests

import chain
from actions import MIN_EXTRA, Z_MIN, ActionReader
from patch import CHANNELS, REACH, WORD_OF, PatchRunner
import duels as duel_rules
from calibrate import MODEL, git_sha
from episode import CONFIG, HERE, Episodes, features
from flybrain.reservoir import Readout


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def house_rows() -> tuple[list[dict], list[dict]]:
    d = json.loads((HERE / "house.json").read_text())
    flies = [{"id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"flybook:house:{f['name']}")), "owner": None, "seed": i, **f}
             for i, f in enumerate(d["flies"])]
    return d["patches"], flies


class SupabaseStore:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/rest/v1"
        self.http = requests.Session()
        self.http.headers.update({"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})

    def _req(self, method: str, path: str, prefer: str | None = None, **kw):
        headers = {"Prefer": prefer} if prefer else {}
        r = self.http.request(method, f"{self.base}/{path}", headers=headers, timeout=30, **kw)
        if not r.ok:
            raise RuntimeError(f"{method} {path}: {r.status_code} {r.text[:300]}")
        return r.json() if r.content else None

    def seed_house(self, patches, flies) -> None:
        self._req("POST", "patches?on_conflict=id", "resolution=merge-duplicates", json=patches)
        self._req("POST", "flies?on_conflict=id", "resolution=merge-duplicates", json=flies)

    def house(self):
        return self._req("GET", "patches?select=*"), self._req("GET", "flies?select=*&order=created_at,name")

    def begin_tick(self, row: dict) -> dict:
        return self._req("POST", "ticks", "return=representation", json=row)[0]

    def add_posts(self, rows: list[dict]) -> list[dict]:
        return self._req("POST", "posts", "return=representation", json=rows) if rows else []

    def add_threads(self, rows: list[dict]) -> None:
        if rows:
            self._req("POST", "threads?on_conflict=parent_post,child_post", "resolution=ignore-duplicates", json=rows)

    def set_positions(self, moves: list[tuple]) -> None:
        for fly_id, x, y, heading in moves:
            self._req("PATCH", f"flies?id=eq.{fly_id}", json={"x": x, "y": y, "heading": heading})

    def finish_tick(self, tick_id: int, stats: dict) -> None:
        self._req("PATCH", f"ticks?id=eq.{tick_id}", json=stats)

    def wallets(self, owners: set[str]) -> dict[str, str]:
        rows = self._req("GET", f"profiles?select=id,wallet&id=in.({','.join(sorted(owners))})")
        return {r["id"]: r["wallet"] for r in rows if r.get("wallet")}

    def set_active(self, fly_id: str, active: bool) -> None:
        self._req("PATCH", f"flies?id=eq.{fly_id}", json={"active": active})

    def pending_pokes(self) -> list[dict]:
        return self._req("GET", "pokes?select=id,patch_id,stimulus,created_at,x,y&consumed_at=is.null&order=id")

    def pending_duels(self, limit: int = 24) -> list[dict]:
        return self._req("GET", f"duels?select=id,kind,a_fly,b_fly&status=eq.pending&order=id&limit={limit}")

    def create_duels(self, rows: list[dict]) -> list[dict]:
        return self._req("POST", "duels", "return=representation", json=rows) if rows else []

    def finish_duel(self, row: dict) -> None:
        self._req("PATCH", f"duels?id=eq.{row['id']}", json={k: v for k, v in row.items() if k != "id"})

    def update_fly(self, fly_id: str, fields: dict) -> None:
        self._req("PATCH", f"flies?id=eq.{fly_id}", json=fields)

    def consume_pokes(self, ids: list[int], tick_id: int) -> None:
        if ids:
            self._req("PATCH", f"pokes?id=in.({','.join(map(str, ids))})", json={"consumed_at": now_iso(), "tick_id": tick_id})


class JsonStore:
    """Same rows as the database, in one file: the web app's demo feed."""

    def __init__(self, path: Path, keep: int = 600):
        self.path, self.keep = path, keep
        self.d = json.loads(path.read_text()) if path.exists() else {"patches": [], "flies": [], "ticks": [], "posts": []}

    def seed_house(self, patches, flies) -> None:
        self.d["patches"], self.d["flies"] = patches, [{**f, "created_at": now_iso()} for f in flies]
        self._save()

    def house(self):
        return self.d["patches"], self.d["flies"]

    def begin_tick(self, row: dict) -> dict:
        tick = {"id": self.d["ticks"][-1]["id"] + 1 if self.d["ticks"] else 1, "started_at": now_iso(),
                "finished_at": None, **row}
        self.d["ticks"].append(tick)
        return tick

    def add_posts(self, rows: list[dict]) -> list[dict]:
        start = self.d["posts"][-1]["id"] + 1 if self.d["posts"] else 1
        new = [{"id": start + i, **r, "correct": None if r["word"] == "nothing" else r["word"] == r["truth"],
                "created_at": now_iso()} for i, r in enumerate(rows)]
        self.d["posts"] = (self.d["posts"] + new)[-self.keep:]
        return new

    def add_threads(self, rows: list[dict]) -> None:
        pass

    def set_positions(self, moves: list[tuple]) -> None:
        where = {m[0]: m[1:] for m in moves}
        for f in self.d["flies"]:
            if f["id"] in where:
                f["x"], f["y"], f["heading"] = where[f["id"]]

    def finish_tick(self, tick_id: int, stats: dict) -> None:
        for t in self.d["ticks"]:
            if t["id"] == tick_id:
                t.update(stats)
        self.d["ticks"] = self.d["ticks"][-50:]
        self._save()

    def wallets(self, owners: set[str]) -> dict[str, str]:
        return {}

    def set_active(self, fly_id: str, active: bool) -> None:
        pass

    def pending_pokes(self) -> list[dict]:
        return []

    def pending_duels(self, limit: int = 24) -> list[dict]:
        return []

    def create_duels(self, rows: list[dict]) -> list[dict]:
        return []

    def finish_duel(self, row: dict) -> None:
        pass

    def update_fly(self, fly_id: str, fields: dict) -> None:
        pass

    def consume_pokes(self, ids: list[int], tick_id: int) -> None:
        pass

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.d, separators=(",", ":")))


def active_flies(store, flies: list[dict]) -> list[dict]:
    """House flies always post. An owned fly posts only while its owner holds $FLYAI; the flag
    is written back so the app can show it as dormant. If the chain can't be read, keep the old flag."""
    owners = {f["owner"] for f in flies if f.get("owner")}
    if not owners:
        return flies
    wallets = store.wallets(owners)
    holder: dict[str, bool | None] = {}
    for owner in owners:
        try:
            holder[owner] = owner in wallets and chain.is_holder(chain.balance_of(wallets[owner]))
        except Exception as e:
            print(f"balance check failed for owner {owner}: {e}", flush=True)
            holder[owner] = None
    out = []
    for f in flies:
        if not f.get("owner"):
            out.append(f)
            continue
        was = f.get("active", True)
        now = was if holder[f["owner"]] is None else holder[f["owner"]]
        if now != was:
            store.set_active(f["id"], now)
        if now:
            out.append(f)
    return out


def load_model():
    vocab = json.loads((MODEL / "vocab.json").read_text())
    if vocab["config"] != json.loads(json.dumps(CONFIG)):
        raise SystemExit("model/vocab.json was trained on a different episode; rerun calibrate.py")
    return Readout.load(MODEL / "translator.npz"), vocab


def draw(mix: dict[str, float], words: list[str], rng) -> str:
    known = {w: float(v) for w, v in mix.items() if w in words and v > 0}
    if not known:
        return "nothing"
    names = list(known)
    p = np.array([known[w] for w in names])
    return names[rng.choice(len(names), p=p / p.sum())]


POKE_FULL, POKE_REACH = 0.12, 0.35   # a poke hits fully within POKE_FULL of its spot, fading to nothing at POKE_REACH


def start_position(fly: dict) -> list[float]:
    """Where a fly is: saved by the last tick, or a fixed spot from its id the first time."""
    if fly.get("x") is not None and fly.get("y") is not None:
        return [float(fly["x"]), float(fly["y"]), float(fly.get("heading") or 0.0)]
    r = np.random.default_rng(uuid.UUID(fly["id"]).int % 2**32)
    return [float(r.uniform(0.3, 0.7)), float(r.uniform(0.3, 0.7)), float(r.uniform(0, 2 * np.pi))]


def patch_batches(flies: list[dict], size: int) -> list[list[dict]]:
    """Brain batches that keep each patch's flies together (flies only affect flies in their batch).
    A patch with more flies than a batch is split, and its parts don't affect each other."""
    by_patch: dict[str, list[dict]] = {}
    for f in flies:
        by_patch.setdefault(f["patch_id"], []).append(f)
    batches, current = [], []
    for members in by_patch.values():
        for k in range(0, len(members), size):
            part = members[k:k + size]
            if current and len(current) + len(part) > size:
                batches.append(current)
                current = []
            current = current + part
    if current:
        batches.append(current)
    return batches


def run_tick(store, eps: Episodes, reader: ActionReader, runner: PatchRunner, translator: Readout, vocab: dict, rng,
             min_precision: float, patches_only: set[str] | None = None, pokes: list[dict] | None = None) -> dict:
    """One pass over every active fly, or just `patches_only` for a poke. Each patch runs as one shared
    brain batch: its event (or its oldest waiting poke) hits one spot, and every other fly only gets what
    its neighbours' brains do (patch.py)."""
    precision = vocab["test"]["precision"]
    postable = sorted(w for w in eps.words if w != "nothing" and precision[w] >= min_precision)
    mean, sd = np.array(vocab["rest"]["mean"]), np.array(vocab["rest"]["sd"])
    if vocab["rest"]["types"] != eps.types.tolist():
        raise SystemExit("DN types differ from the calibration brain; rerun calibrate.py")
    patches, flies = store.house()
    flies = active_flies(store, flies)
    if patches_only is not None:
        flies = [f for f in flies if f["patch_id"] in patches_only]
    if not flies:
        return {}
    poke_for: dict[str, dict] = {}
    for pk in (store.pending_pokes() if pokes is None else pokes):
        poke_for.setdefault(pk["patch_id"], pk)          # the oldest waiting poke per patch
    mixes = {p["id"]: p["event_mix"] for p in patches}
    seed = int(rng.integers(2**31))
    t0 = time.perf_counter()
    tick = store.begin_tick({
        "git_sha": os.environ.get("GIT_SHA") or git_sha(),
        "config": {**vocab["config"], "min_precision": min_precision, "seed": seed,
                   "patches": sorted(patches_only) if patches_only is not None else "all",
                   "pokes": sorted(p["id"] for p in poke_for.values()),
                   "actions": {"z_min": Z_MIN, "min_extra": MIN_EXTRA, "rest": reader.rest},
                   "social": {"reach": REACH, "channels": CHANNELS, "poke_full": POKE_FULL, "poke_reach": POKE_REACH}},
        "translator": {"version": vocab["version"], "precision": precision, "recall": vocab["test"]["recall"],
                       "postable": postable},
    })
    B = eps.brain.batch
    rows, moves, replay = [], [], {}
    for n, batch in enumerate(patch_batches(flies, B)):
        pad = B - len(batch)
        pos = np.array([start_position(f) for f in batch] + [[0.5, 0.5, 0.0]] * pad)
        direct: list[tuple[str | None, float]] = [(None, 0.0)] * B
        events = {}
        for pid in dict.fromkeys(f["patch_id"] for f in batch):
            idx = [i for i, f in enumerate(batch) if f["patch_id"] == pid]
            poke = poke_for.get(pid)
            if poke:
                spot = (float(poke["x"]) if poke.get("x") is not None else 0.5,
                        float(poke["y"]) if poke.get("y") is not None else 0.5)
                d = np.hypot(pos[idx, 0] - spot[0], pos[idx, 1] - spot[1])
                strength = np.clip((POKE_REACH - d) / (POKE_REACH - POKE_FULL), 0.0, 1.0)
                strength[int(np.argmin(d))] = 1.0                  # a poke always reaches the nearest fly
                for i, k in zip(idx, strength):
                    if k > 0:
                        direct[i] = (poke["stimulus"], float(k))
                events[pid] = {"stimulus": poke["stimulus"], "x": spot[0], "y": spot[1], "poke_id": poke["id"], "fly_id": None}
            else:
                word = draw(mixes[pid], eps.words, rng)
                if word != "nothing":
                    focal = idx[int(rng.integers(len(idx)))]
                    direct[focal] = (word, 1.0)
                    events[pid] = {"stimulus": word, "x": float(pos[focal, 0]), "y": float(pos[focal, 1]),
                                   "poke_id": None, "fly_id": batch[focal]["id"]}
                else:
                    events[pid] = {"stimulus": "nothing", "poke_id": None, "fly_id": None}
        settings = [{k: f.get(k) or {} for k in ("senses", "temperament", "dials")} for f in batch] + [{}] * pad
        patch_of = [f["patch_id"] for f in batch] + [None] * pad
        res = runner.run(direct, pos, patch_of, settings, seed=seed + n)
        counts, wing = res["counts"][:len(batch)], res["wing"][:len(batch)]
        probs = translator.predict(features(counts))
        did = reader.read(counts, wing)
        for i, fly in enumerate(batch):
            x, y, h = res["positions"][i]
            moves.append((fly["id"], round(float(x), 3), round(float(y), 3), round(float(h) % (2 * np.pi), 2)))
            word = eps.words[int(np.argmax(probs[i]))]
            said = word in postable
            if not said and not did[i]:
                continue                                   # read nothing, did nothing: no post
            hit = direct[i][0]
            cause = None if hit else runner.cause(res, i)
            truth = hit or (WORD_OF.get(cause["channel"], "nothing") if cause else "nothing")
            if said:
                kind = "sense" if word == truth else ("hallucination" if truth == "nothing" and not cause else "misread")
            else:
                kind, word = "action", "nothing"
            poke = poke_for.get(fly["patch_id"]) if hit else None
            rows.append({"tick_id": tick["id"], "fly_id": fly["id"], "patch_id": fly["patch_id"], "word": word,
                         "confidence": round(precision[word], 3) if said else 0.0, "truth": truth, "kind": kind,
                         "actions": did[i], "poke_id": poke["id"] if poke else None,
                         "cause": {"channel": cause["channel"], "from_fly_id": batch[cause["from"]]["id"],
                                   "strength": cause["strength"]} if cause else None,
                         "wing_hz": round(float(wing[i]), 1), "neurons": eps.cite(counts[i], mean, sd)})
        for pid, event in events.items():
            idx = [i for i, f in enumerate(batch) if f["patch_id"] == pid]
            local = set(idx)
            replay[pid] = {"flies": [batch[i]["id"] for i in idx], "event": event,
                           "frames": [[frame[i] for i in idx] for frame in res["frames"]],
                           "links": [{"from": batch[l["from"]]["id"], "to": batch[l["to"]]["id"],
                                      "channel": l["channel"], "step": l["step"]}
                                     for l in res["links"] if l["from"] in local and l["to"] in local]}
    inserted = store.add_posts(rows)
    post_of = {p["fly_id"]: p["id"] for p in inserted}
    threads = [{"parent_post": post_of[p["cause"]["from_fly_id"]], "child_post": p["id"], "cause": p["cause"]["channel"]}
               for p in inserted if p.get("cause") and p["cause"]["from_fly_id"] in post_of]
    store.add_threads(threads)
    store.set_positions(moves)
    store.consume_pokes([p["id"] for p in poke_for.values()], tick["id"])
    stats = {"finished_at": now_iso(), "flies": len(flies), "posts": len(rows),
             "seconds": round(time.perf_counter() - t0, 1), "replay": replay}
    store.finish_tick(tick["id"], stats)
    kinds = {k: sum(r["kind"] == k for r in rows) for k in ("sense", "misread", "hallucination", "action")}
    where = f" patches {sorted(patches_only)}" if patches_only is not None else ""
    print(f"tick {tick['id']}{where}: {len(flies)} flies, {len(rows)} posts {kinds}, "
          f"caused by a neighbour {sum(bool(r['cause']) for r in rows)}, threads {len(threads)}, pokes {len(poke_for)}, "
          f"{stats['seconds']} s", flush=True)
    return stats


AUTO_DUELS = 2     # matchmade duels per full tick


def duel_pass(store, runner: PatchRunner, rng, auto: int = 0) -> int:
    """Matchmake `auto` duels among active flies, then fight every pending duel and settle Elo."""
    _, flies = store.house()
    active = active_flies(store, flies)
    by_id = {f["id"]: f for f in active}
    if auto:
        store.create_duels([{"kind": duel_rules.KINDS[int(rng.integers(2))], "a_fly": a["id"], "b_fly": b["id"]}
                            for a, b in duel_rules.matchmake(active, auto, rng)])
    pending = store.pending_duels()
    if not pending:
        return 0
    results = duel_rules.run_duels(runner, pending, by_id, seed=int(rng.integers(2**31)))
    settled = 0
    for row in results:
        store.finish_duel(row)
        if row["status"] != "done":
            continue
        d = next(p for p in pending if p["id"] == row["id"])
        a, b = by_id[d["a_fly"]], by_id[d["b_fly"]]
        for fly, sign in ((a, 1), (b, -1)):
            won = row["winner"] == fly["id"]
            drawn = row["winner"] is None
            fields = {"elo": (fly.get("elo") or 1000) + sign * row["delta"], "duels": (fly.get("duels") or 0) + 1,
                      "wins": (fly.get("wins") or 0) + won, "losses": (fly.get("losses") or 0) + (not won and not drawn),
                      "draws": (fly.get("draws") or 0) + drawn}
            store.update_fly(fly["id"], fields)
            fly.update(fields)
        settled += 1
        names = {a["id"]: a["name"], b["id"]: b["name"]}
        print(f"duel {row['id']} {d['kind']}: {a['name']} ({row['a_step']} ms) vs {b['name']} ({row['b_step']} ms) -> "
              f"{names.get(row['winner'], 'draw')}, elo delta {row['delta']}", flush=True)
    return settled


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--json", help="write to this JSON file instead of Supabase")
    p.add_argument("--ticks", type=int, default=1, help="ticks to run back to back (ignored with --every)")
    p.add_argument("--every", type=float, help="run forever, one tick every this many seconds")
    p.add_argument("--poke-poll", type=float, default=10.0, help="with --every: check for pokes this often (seconds)")
    p.add_argument("--batch", type=int, default=12, help="flies per brain batch")
    p.add_argument("--min-precision", type=float, default=0.6)
    p.add_argument("--seed-house", action="store_true", help="upsert the house flies and patches first (off at launch)")
    p.add_argument("--seed", type=int, help="tick RNG seed (default: clock)")
    args = p.parse_args()

    if args.json:
        store = JsonStore(Path(args.json))
    else:
        url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not (url and key):
            raise SystemExit("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --json PATH")
        store = SupabaseStore(url, key)
    if args.seed_house:                               # house flies only on request; launch has none
        store.seed_house(*house_rows())

    translator, vocab = load_model()
    t0 = time.perf_counter()
    eps = Episodes(batch=args.batch)
    print(f"brain loaded in {time.perf_counter() - t0:.1f} s; translator {vocab['version']}", flush=True)
    reader = ActionReader(eps)
    t0 = time.perf_counter()
    rest = reader.fit()
    print(f"action rest fitted in {time.perf_counter() - t0:.0f} s: {rest}", flush=True)
    runner = PatchRunner(eps, reader)
    rng = np.random.default_rng(args.seed if args.seed is not None else time.time_ns())

    if args.every:
        next_full = time.monotonic()
        while True:
            try:
                if time.monotonic() >= next_full:
                    next_full = time.monotonic() + args.every
                    run_tick(store, eps, reader, runner, translator, vocab, rng, args.min_precision)
                    duel_pass(store, runner, rng, auto=AUTO_DUELS)
                else:
                    waiting = store.pending_pokes()
                    if waiting:
                        run_tick(store, eps, reader, runner, translator, vocab, rng, args.min_precision,
                                 patches_only={p["patch_id"] for p in waiting}, pokes=waiting)
                    duel_pass(store, runner, rng)
            except Exception as e:                    # a failed tick must not kill the loop
                print(f"tick failed: {e}", flush=True)
            time.sleep(max(0.5, min(args.poke_poll, next_full - time.monotonic())))
    for _ in range(args.ticks):
        run_tick(store, eps, reader, runner, translator, vocab, rng, args.min_precision)
        if not args.json:
            duel_pass(store, runner, rng, auto=AUTO_DUELS)


if __name__ == "__main__":
    main()
