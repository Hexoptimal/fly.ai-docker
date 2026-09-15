"""Fly Radio: a live station driven by the real MaleCNS connectome.

One batched `flybrain.FlyBrain` runs forever, one column per cast member
(radio/channels.py's SHOWS). Every step, each column gets its fixed context
stimulus (flytalk.CONTEXTS, injected via `FlyBrain.step(inject=...)`); its
wing-motor-neuron loudness (flytalk.sound_of, "song" above rest) is chunked
into ~100 ms pieces and turned into PCM audio (radio/audio.py), streamed live
over HTTP to whichever browser tab is listening -- nothing is pre-rendered or
looped, every chunk is the brain's current state. Captions (radio/decode.py)
read the same envelope through a small cross-validated readout, calibrated
once at startup, and are pushed over Server-Sent Events.

There's no artificial real-time pacing: the loop runs exactly as fast as this
machine can step a 166,700-neuron connectome (batch=5). On a fast device that
may be close to real-time; on a slow CPU it'll be slower than real-time but
still genuinely live -- see radio/README.md.

Served at http://127.0.0.1:8790 (mirrors sshfighter/fly_dashboard.py's stdlib
ThreadingHTTPServer + Server-Sent Events pattern; no new dependencies).

    python radio/server.py
    python radio/server.py --port 8791 --device cuda
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from flybrain import FlyBrain  # noqa: E402  (path insert must come first)
from flytalk import CONTEXTS, Counter, wing_groups, windows  # noqa: E402

import audio  # noqa: E402
import channels  # noqa: E402
import decode  # noqa: E402

SAMPLE_RATE = 22050
CHUNK_S = 0.10          # one audio chunk = 100 ms of PCM
CAPTION_S = 2.0         # recompute captions every 2 s
DEFAULT_PORT = 8790

# Cross-origin: only needed if a client is fetched from a different origin than this
# server's own (e.g. testing radio/site.html against a deployed backend directly instead of
# through the site's same-origin proxy). Same pattern as flybook/worker/api.py's FLYBOOK_ORIGINS.
ORIGINS = {o.strip() for o in os.environ.get(
    "RADIO_ORIGINS", "https://flyaiworld.com,https://www.flyaiworld.com,http://localhost:8790").split(",") if o.strip()}


def build_injections(brain, cast: list[channels.Member]) -> list:
    """Every cast member's context, fixed forever, one column each -- unlike
    flytalk's per-trial randomized context, nothing here ever changes, so this
    is built once and reused every step."""
    out = []
    for member in cast:
        for types, amount in CONTEXTS[member.context]:
            idx = brain.cells(types)
            vec = np.zeros(brain.batch, np.float32)
            vec[member.column] = amount
            out.append((idx, vec))
    return out


class Studio:
    def __init__(self, seed: int = 1, device: str = "auto", dt: float = 0.020,
                 calibration_trials: int = decode.CALIBRATION_TRIALS,
                 cache_readout: bool = True, recalibrate: bool = False):
        self.cast = channels.assign_columns()
        self.shows = channels.SHOWS
        self.dt = dt

        print(f"radio: loading connectome, {len(self.cast)} live flies "
              f"({', '.join(m.name for m in self.cast)})...", flush=True)
        self.brain = FlyBrain(device=device, batch=len(self.cast), seed=seed, dt=dt, sensory_input=False)
        self.injections = build_injections(self.brain, self.cast)
        wing = wing_groups(self.brain)
        self.counter = Counter(self.brain, {k: v for k, v in wing.items() if len(v)})

        print("radio: preparing caption readout...", flush=True)
        self.readout, self.rest = decode.calibrate_cached(
            self.brain, trials=calibration_trials, seed=7, cache=cache_readout, force=recalibrate)
        self.brain.reset(seed)

        self.voices = {m.column: audio.Voice(pitch=m.pitch, tone=m.tone) for m in self.cast}
        self.turn_state = {s.id: {"speaker": 0, "elapsed": 0.0} for s in self.shows if s.turn_seconds}
        self.rng = np.random.default_rng(seed + 1)
        self.t = 0.0  # generated audio-seconds elapsed (drives turn-taking, not wall clock)
        self._running = True

        # The brain only steps while someone is actually tuned in (a PCM or captions stream
        # connected) -- so a deployed machine with fly.io's auto-stop can go fully idle (no CPU,
        # no cost) between listeners instead of simulating forever with nobody hearing it.
        self.activity = threading.Condition()
        self.listeners = 0

        self.audio_streams = {s.id: {"cond": threading.Condition(), "seq": 0, "chunk": None} for s in self.shows}
        self.captions_cond = threading.Condition()
        self.captions_log: list[str] = []  # append-only log, not a single slot: one caption cycle
        # publishes once per show in a tight loop, and a single-slot "latest value" (like
        # audio_streams) would let later shows silently overwrite earlier ones before the
        # SSE reader thread ever wakes up to send them.

        self.shows_json = json.dumps([{
            "id": s.id, "name": s.name, "tagline": s.tagline, "noise": s.noise,
            "turn_taking": s.turn_seconds is not None,
            "cast": [{"role": m.role, "name": m.name, "context": m.context} for m in s.cast],
        } for s in self.shows])

    def add_listener(self) -> None:
        with self.activity:
            self.listeners += 1
            self.activity.notify_all()

    def remove_listener(self) -> None:
        with self.activity:
            self.listeners = max(0, self.listeners - 1)

    def _publish_audio(self, show_id: str, pcm_bytes: bytes) -> None:
        stream = self.audio_streams[show_id]
        with stream["cond"]:
            stream["chunk"] = pcm_bytes
            stream["seq"] += 1
            stream["cond"].notify_all()

    def _publish_caption(self, show_id: str, speaker_name: str, text: str, confidence: float) -> None:
        payload = json.dumps({"show": show_id, "speaker": speaker_name, "text": text,
                               "confidence": round(confidence, 3), "t": round(self.t, 1)})
        with self.captions_cond:
            self.captions_log.append(payload)
            del self.captions_log[:-200]  # bound memory; well beyond what any client needs to catch up on
            self.captions_cond.notify_all()

    def _on_mic(self, show: channels.Show) -> channels.Member:
        if not show.turn_seconds:
            return show.cast[0]
        return show.cast[self.turn_state[show.id]["speaker"]]

    def loop(self) -> None:
        """The live simulation loop: step the brain, chunk audio, caption on a
        slower cadence. Runs until KeyboardInterrupt."""
        chunk_steps = max(1, round(CHUNK_S / self.dt))
        caption_steps = windows(self.dt)[1]  # matches decode.py's calibration window
        caption_every = max(1, round(CAPTION_S / self.dt))

        buffers = {m.column: [] for m in self.cast}
        cap_hist = {m.column: deque(maxlen=caption_steps) for m in self.cast}
        steps_since_caption = 0

        print("radio: live", flush=True)
        idle = True
        while self._running:
            with self.activity:
                self.activity.wait_for(lambda: self.listeners > 0 or not self._running, timeout=5)
                now_idle = self.listeners == 0
            if not self._running:
                break
            if now_idle:
                if not idle:
                    print("radio: idle, nobody tuned in -- pausing the brain", flush=True)
                idle = True
                continue
            if idle:
                print("radio: listener connected -- resuming the brain", flush=True)
                idle = False

            fired = self.brain.step(inject=self.injections)
            loud = np.maximum(self.counter(fired).sum(-1) - self.rest, 0.0)  # (batch,)
            for m in self.cast:
                buffers[m.column].append(float(loud[m.column]))
                cap_hist[m.column].append(float(loud[m.column]))

            if len(buffers[self.cast[0].column]) >= chunk_steps:
                self.t += CHUNK_S
                for show in self.shows:
                    if show.turn_seconds:
                        st = self.turn_state[show.id]
                        st["elapsed"] += CHUNK_S
                        if st["elapsed"] >= show.turn_seconds[st["speaker"]]:
                            st["speaker"] = 1 - st["speaker"]
                            st["elapsed"] = 0.0
                    member = self._on_mic(show)
                    env = np.array(buffers[member.column], np.float32)
                    pcm = self.voices[member.column].synthesize(env, self.dt, SAMPLE_RATE, show.noise, self.rng)
                    self._publish_audio(show.id, audio.to_bytes(pcm))
                for m in self.cast:
                    buffers[m.column].clear()

            steps_since_caption += 1
            if steps_since_caption >= caption_every:
                steps_since_caption = 0
                for show in self.shows:
                    member = self._on_mic(show)
                    hist = cap_hist[member.column]
                    if len(hist) == caption_steps:
                        text, conf = decode.caption(self.readout, np.array(hist, np.float32), self.dt)
                        self._publish_caption(show.id, member.name, text, conf)


class StationState:
    """Holds the Studio once it's ready. The HTTP server binds and starts answering requests
    immediately, before the (possibly slow -- a first run downloads the ~260 MB connectome)
    brain load and caption-readout check finish, so a visitor sees a friendly "warming up" page
    instead of a stalled connection -- see main()."""

    def __init__(self) -> None:
        self.studio: Studio | None = None


WARMUP_PAGE = """<!doctype html>
<title>Fly Radio</title>
<meta http-equiv="refresh" content="4">
<style>
  body{margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
       background:#07090c; color:#eef1f5; font:16px/1.6 'Inter',system-ui,sans-serif; text-align:center;}
  .box{max-width:440px; padding:32px;}
  h1{font:700 26px 'Space Grotesk',sans-serif; margin:0 0 14px;}
  p{color:#95a0ae; margin:0 0 8px; font-size:15px;}
  .dot{display:inline-block; width:8px; height:8px; border-radius:50%; background:#e0342c;
       animation:pulse 1.2s ease-in-out infinite; margin-right:8px;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.3;}}
</style>
<div class="box">
  <h1><span class="dot"></span>Fly Radio is warming up</h1>
  <p>Loading a real 166,700-neuron connectome and checking the caption readout.</p>
  <p>Usually a few seconds; up to a minute or two on a completely cold start.
  This page refreshes on its own.</p>
</div>
"""


def _handler(state: StationState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin in ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def _client_gone(self) -> bool:
            """write() to a dead socket doesn't reliably fail right away -- the OS can accept
            writes into the send buffer for a while after the browser closed its end (this is
            why listener counts were sticking around after a refresh instead of dropping: the
            dead connection's thread just never got an error to catch). A non-blocking peek read
            catches it immediately instead: an empty read means the peer already sent FIN, which
            is exactly what happens when a fetch()/EventSource is aborted or the tab navigates
            away. Checked every loop iteration in _stream_pcm/_stream_captions."""
            try:
                self.connection.setblocking(False)
                return self.connection.recv(1, socket.MSG_PEEK) == b""
            except BlockingIOError:
                return False
            except OSError:
                return True
            finally:
                self.connection.setblocking(True)

        def _send(self, body: bytes, ctype: str, status: int = 200) -> None:
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            studio = state.studio
            if self.path == "/":
                if studio is None:
                    return self._send(WARMUP_PAGE.encode(), "text/html; charset=utf-8")
                return self._send(PAGE.encode(), "text/html; charset=utf-8")
            if self.path == "/health":
                return self._send(b"ok", "text/plain")
            if self.path == "/assets/logo.webp" and LOGO is not None:
                # site.html's nav references this by absolute path (/assets/logo.webp), which in
                # production resolves straight to the real site's static file, bypassing this
                # entirely -- this route only exists so the page also looks right locally, run
                # standalone with no site to proxy it (see radio/README.md's "On the site").
                return self._send(LOGO, "image/webp")
            if studio is None:
                # every remaining route needs the brain -- still loading/calibrating (see
                # StationState). WARMUP_PAGE doesn't call any of these itself, so in practice
                # only a stray direct request would ever hit this.
                return self._send(b'{"error":"warming up"}', "application/json", status=503)
            if self.path == "/debug/listeners":
                # temporary diagnostic: how many PCM/caption streams the server currently thinks
                # are connected, and whether the brain loop believes it's idle. Query it directly
                # to check the idle-pause logic instead of guessing from terminal-log timing.
                body = json.dumps({"listeners": studio.listeners}).encode()
                return self._send(body, "application/json")
            if self.path == "/shows.json":
                return self._send(studio.shows_json.encode(), "application/json")
            if self.path.startswith("/pcm/"):
                return self._stream_pcm(studio, self.path[len("/pcm/"):])
            if self.path == "/captions":
                return self._stream_captions(studio)
            return self.send_error(404)

        def _stream_pcm(self, studio: Studio, show_id: str) -> None:
            stream = studio.audio_streams.get(show_id)
            if stream is None:
                return self.send_error(404)
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", f"audio/L16; rate={SAMPLE_RATE}; channels=1")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            seen = -1
            studio.add_listener()
            try:
                while True:
                    if self._client_gone():
                        return
                    with stream["cond"]:
                        fresh = stream["cond"].wait_for(lambda: stream["seq"] != seen, timeout=15)
                        seen, chunk = stream["seq"], stream["chunk"]
                    if fresh and chunk:
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except OSError:
                return
            finally:
                studio.remove_listener()

        def _stream_captions(self, studio: Studio) -> None:
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            seen = len(studio.captions_log)  # start from "now", not the whole backlog
            studio.add_listener()
            try:
                while True:
                    if self._client_gone():
                        return
                    with studio.captions_cond:
                        fresh = studio.captions_cond.wait_for(lambda: len(studio.captions_log) > seen, timeout=15)
                        pending = studio.captions_log[seen:] if fresh else []
                        seen = len(studio.captions_log)
                    if pending:
                        for payload in pending:
                            self.wfile.write(f"data: {payload}\n\n".encode())
                    else:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except OSError:
                return
            finally:
                studio.remove_listener()

    return Handler


PAGE = (Path(__file__).resolve().parent / "site.html").read_text(encoding="utf-8")

_logo_path = Path(__file__).resolve().parent.parent / "docs" / "assets" / "logo.webp"
LOGO = _logo_path.read_bytes() if _logo_path.exists() else None


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"),
                   help='bind address; use "0.0.0.0" when deployed (e.g. behind fly.io)')
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)))
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--device", default="auto", help='"cpu", "cuda", or "auto"')
    p.add_argument("--dt", type=float, default=0.020, help="brain step in seconds")
    p.add_argument("--calibration-trials", type=int, default=decode.CALIBRATION_TRIALS)
    p.add_argument("--no-cache", action="store_true",
                   help="don't read or write radio/model/readout.npz -- always calibrate fresh in memory")
    p.add_argument("--recalibrate", action="store_true",
                   help="ignore any cached readout and recalibrate now, overwriting the cache")
    p.add_argument("--no-browser", action="store_true")
    args = p.parse_args()

    # The HTTP server binds and starts answering *before* Studio() below, which can take a
    # while (first-run connectome download, brain load, checking/building the caption-readout
    # cache) -- so a visitor gets WARMUP_PAGE instead of a refused connection while that runs.
    state = StationState()
    server = ThreadingHTTPServer((args.host, args.port), _handler(state))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}/"
    print(f"radio: {url}  (warming up...)", flush=True)
    if not args.no_browser:
        webbrowser.open(url)

    try:
        studio = Studio(seed=args.seed, device=args.device, dt=args.dt,
                         calibration_trials=args.calibration_trials,
                         cache_readout=not args.no_cache, recalibrate=args.recalibrate)
        state.studio = studio
        studio.loop()
    except KeyboardInterrupt:
        if state.studio is not None:
            state.studio._running = False
        print("\nradio: stopping", flush=True)


if __name__ == "__main__":
    main()
