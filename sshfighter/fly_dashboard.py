"""Live dashboard: the fight on the left, the fly's nervous system on the right.

Served at http://127.0.0.1:8777 by fly_fighter.py --dashboard. Streams one
update per game frame over Server-Sent Events (no extra dependencies).
Every dot on the brain map is a real neuron at its measured soma position in
the MaleCNS volume; lit dots fired during the last frame (sampled if many).
"""
from __future__ import annotations

import json
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

MAX_SPIKES = 6000
MOTOR_LABELS = {
    "steer": ("DNa02", "steer"), "escape": ("DNp01", "jump"), "forward": ("DNg100", "walk"),
    "backward": ("MDN", "back"), "punch": ("DNg11", "punch"), "kick": ("pIP10", "kick"),
}


class Dashboard:
    def __init__(self, fly, port: int = 8777):
        self.fly = fly
        self.port = port
        brain = fly.brain
        if brain.positions is None:
            raise SystemExit("brain.npz has no positions; rerun build_brain.py")
        ok = ~np.isnan(brain.positions).any(axis=1)
        self.pos_index = np.full(brain.n, -1, np.int32)
        self.pos_index[ok] = np.arange(ok.sum(), dtype=np.int32)
        # EM volume axes: x = left-right, z = the long body axis (brain -> nerve cord).
        xy = brain.positions[ok][:, [0, 2]].copy()
        # Draw the fly's right side on the viewer's right (as seen from above/behind).
        side = brain.side[ok]
        if np.nanmean(xy[side == "R", 0]) < np.nanmean(xy[side == "L", 0]):
            xy[:, 0] = -xy[:, 0]
        lo, hi = np.percentile(xy, 0.2, axis=0), np.percentile(xy, 99.8, axis=0)
        scale = (hi - lo).max()
        pad = ((scale - (hi - lo)) / 2)
        norm = np.clip((xy - lo + pad) / scale, 0, 1) * 1000
        groups = {}
        for name, idx in brain.groups.items():
            groups[name] = [int(i) for i in self.pos_index[idx] if i >= 0]
        for channel, per_side in fly.features.cells.items():
            for s, idx in per_side.items():
                groups[f"{channel}{s}"] = [int(i) for i in self.pos_index[idx] if i >= 0]
        self.static = json.dumps({
            "x": norm[:, 0].round().astype(int).tolist(), "y": norm[:, 1].round().astype(int).tolist(),
            "groups": groups, "labels": MOTOR_LABELS, "neurons": int(brain.n),
            "connections": int(len(brain.indices)), "mapped": int(ok.sum()),
        })
        self.cond = threading.Condition()
        self.payload: str | None = None
        self.seq = 0
        self.mid: str | None = None
        self.opp_name = ""
        self.rng = np.random.default_rng(0)

    def set_match(self, mid: str | None, opp_name: str | None = None) -> None:
        self.mid, self.opp_name = mid, opp_name or ""

    def publish(self, state: dict, cmd: dict, fly) -> None:
        spikes = self.pos_index[fly.frame_spikes]
        spikes = spikes[spikes >= 0]
        if len(spikes) > MAX_SPIKES:
            spikes = self.rng.choice(spikes, MAX_SPIKES, replace=False)
        now = {g: bool(np.isin(idx, fly.frame_spikes).any()) for g, idx in fly.brain.groups.items()}
        you, opp = state.get("you") or {}, state.get("opp") or {}
        fighter = lambda f: {"x": f.get("x", 0), "y": f.get("y", 0), "hp": f.get("hp", 0),
                             "facing": f.get("facing", 1), "name": f.get("character", "")}
        payload = {
            "mid": self.mid, "opp_name": self.opp_name, "phase": state.get("phase"), "round": state.get("round"),
            "you": fighter(you), "opp": fighter(opp),
            "shots": [[p.get("x", 0), p.get("y", 20), p.get("ownedBy") == "opponent"]
                      for p in state.get("projectiles") or []],
            "cmd": {k: v for k, v in cmd.items() if k != "t"},
            "spikes": spikes.tolist(), "total": int(len(fly.frame_spikes)),
            "counts": fly.decoder.snapshot(), "now": now, "drive": fly.features.last,
            "ms": round(fly.step_ms, 1),
        }
        with self.cond:
            self.payload = json.dumps(payload)
            self.seq += 1
            self.cond.notify_all()

    def start(self, open_browser: bool = True) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", self.port), _handler(self))
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{self.port}/"
        print(f"dashboard: {url}", flush=True)
        if open_browser:
            webbrowser.open(url)


def _handler(dash: Dashboard):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, body: bytes, ctype: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/":
                return self._send(PAGE.encode(), "text/html; charset=utf-8")
            if self.path == "/static.json":
                return self._send(dash.static.encode(), "application/json")
            if self.path != "/events":
                return self.send_error(404)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            seen = -1
            try:
                while True:
                    with dash.cond:
                        fresh = dash.cond.wait_for(lambda: dash.seq != seen, timeout=15)
                        seen, data = dash.seq, dash.payload
                    self.wfile.write(f"data: {data}\n\n".encode() if fresh and data else b": ping\n\n")
                    self.wfile.flush()
            except OSError:
                return

    return Handler


PAGE = (Path(__file__).resolve().parent / "dashboard.html").read_text(encoding="utf-8")
