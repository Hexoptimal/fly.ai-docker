# Fly Radio

**A radio station run by an actual fly brain, live.** Four shows, five flies,
one batched `flybrain.FlyBrain` — the real 166,700-neuron MaleCNS connectome —
stepping forever. Every buzz you hear is that brain's own wing-motor-neuron
activity, streamed the instant it's measured: nothing is pre-rendered, nothing
loops. Same "frozen connectome + readout" pattern as
[`valentfly/`](../valentfly/) and [`flytalk.py`](../flytalk.py), just live and
audible instead of baked into a report.

## The lineup

Every show reuses one of `flytalk.py`'s already-real stimulus contexts (no new
neuron-population mappings invented here — see `flytalk.CONTEXTS`):

| Show | Cast | Context | What's playing |
|---|---|---|---|
| **White Noise** | Nobody | `baseline` (no stimulus) | Actual hiss, no tone — the resting activity of an undriven fly brain, with the carrier turned off (`tone=0`, see below) so it reads as static rather than a quiet buzz. |
| **Buzzkill** | The Suspect | `threat` (LC4 + LPLC2, looming) | True crime, fly-sized. |
| **Rotten and Tasty** | The Critic | `food` (ORN_DM1 + ORN_DM2) | One fly, one plate, zero chill. |
| **The Mating Call** | Buzzy Buzz (presenter) / Dr. Buzziam Buzz (expert) | `baseline` / `mate` (LC10a) | A talk show: the mic alternates between the two — Buzzy Buzz "asks" for 2.5 s, Dr. Buzziam Buzz "answers" for 4 s, on a loop. Both flies keep running the whole time; only the one on-mic drives that stretch of audio. |

## How it works

**The brain.** `flybrain.FlyBrain` loads the real MaleCNS connectome —
166,700 actual fly neurons and their real, measured synaptic wiring — and
simulates it as a live spiking network. It is never trained and nothing here
is scripted: one connectome, stepping forever, for as long as the server is
running (`radio/server.py`).

**Stimulus in.** Each of the 5 cast members is one column of a batched brain
(`FlyBrain(batch=5)`), and each column has a fixed, real stimulus wired into
it permanently — e.g. The Suspect's column gets voltage injected into the
real neurons `LC4`/`LPLC2` (a fly's actual looming-detection circuit) on
every single step, forever. That's the entire "input" any column ever gets;
nothing is scripted, timed, or scored (`radio/server.py:build_injections`,
reusing `flytalk.CONTEXTS` directly — see the lineup table above for which
context drives which cast member).

**Sound out.** Every step, the server counts how hard that column's real
wing-motor neurons — the actual circuit that would drive a fly's wingbeat —
are firing above their resting rate. That one measured number, over time
(`flytalk.sound_of()`'s definition of loudness), is the *only* real
ingredient in the audio: it amplitude-modulates a synthetic ~190 Hz tone
(`radio/audio.py`) so it's audible. The tone itself — and the noise floor, and
the per-voice pitch tweak — is a made-up sonification choice, not a
reconstruction of real wing mechanics, same honesty as valentfly's own "made
up, plainly" section. White Noise's cast member ("Nobody") has that tone
turned off entirely (`Member(tone=0)`) — the real envelope still controls how
loud the *noise* gets, there's just no carrier riding on it, so it reads as
actual static rather than a quiet buzz.

**Text out.** Once at startup, a small classifier
(`flybrain.reservoir.Readout`) is trained — via the same trial loop
`flytalk.speak()`/`flytalk.py` itself uses, cross-validated so it isn't just
memorizing — to recognize what each of the 4 known contexts' wing-loudness
signature looks like. Live, every ~2 seconds, that same classifier is handed
a rolling window of a cast member's real measured envelope — just numbers, no
label attached — and it independently guesses which context that resembles
(`radio/decode.py`). The percentage shown next to each caption is that
guess's own confidence; it is not hand-tuned or guaranteed correct, and often
genuinely isn't — Buzzkill's threat signal happens to be loud and distinctive
on this connectome, so it reads correctly most of the time, while mate/food
sit much closer to resting noise and get misread far more often. That's the
point: it's a real decode, not an echo of whichever context is actually
driving the column.

**No artificial pacing.** The simulation loop runs exactly as fast as this
machine can step a 166,700-neuron connectome; it does not try to match
wall-clock real time. On CPU that's noticeably slower than real-time (a
short calibration run on one workstation measured ~120 ms/step at
batch=4) — the radio will feel more like a slow, live broadcast than a
snappy one, but it is never looped or pre-rendered. On CUDA it should feel
much closer to real-time.

**What the output actually is.** For each of the 4 shows, two live HTTP
streams, both generated fresh at the moment they're requested — nothing is
ever pre-rendered or replayed:
- `GET /pcm/<show-id>` — a never-ending stream of raw 16-bit PCM audio
  (mono, 22.05 kHz), one ~100 ms chunk at a time.
- `GET /captions` — a Server-Sent Events stream of small JSON lines, one per
  caption update, e.g.
  `{"show": "buzzkill", "speaker": "The Suspect", "text": "threat", "confidence": 0.91, "t": 42.6}`.

`radio/site.html` is just a browser client for those two streams (plus
`GET /shows.json` for the static show/cast list) — it schedules the PCM
through the Web Audio API and renders each caption line as it arrives. You
could point curl, or any other client, at the same two endpoints directly.

## Files

| File | What it does |
|---|---|
| `channels.py` | The show lineup and cast — imports `flytalk.CONTEXTS` directly, no duplication. Self-test via `python radio/channels.py` (no brain needed). |
| `audio.py` | Envelope → PCM synthesis (the sonification layer). Self-test via `python radio/audio.py` (no brain needed). |
| `decode.py` | Calibrates and applies the live caption readout, reusing `flytalk.speak`/`flybrain.reservoir.Readout`. `python radio/decode.py` runs a standalone calibration + spot-check (needs the connectome); `--cache` also saves it to `model/`. `calibrate_cached()` is what `server.py` actually calls — it reuses `model/readout.npz` when its fingerprint still matches, instead of recalibrating from scratch. |
| `server.py` | The live station: one background simulation loop, a stdlib `ThreadingHTTPServer` (same pattern as `sshfighter/fly_dashboard.py`) streaming raw PCM per show and captions over Server-Sent Events. Captions are delivered from an append-only log the SSE handler fully drains each cycle (not a single "latest value" slot) — with 4 shows publishing back-to-back every cycle, a single-slot pattern silently drops all but the last one written. The simulation loop itself only runs while at least one stream is connected (see "On the site" below). |
| `site.html` | The client the server serves at `/` — a fly (wearing headphones) sitting at a desk with a microphone, a power button to turn the set on/off, numbered channel buttons, a VU meter, and a "Translation" panel on the right showing the live captions. |
| `model/` | The cached caption readout (`readout.npz` + `readout.json`) `decode.py`'s `calibrate_cached()` reads and writes. See `model/README.md`. |

No new dependencies: everything here uses `numpy` (already required) and
Python's standard library (`http.server`, `threading`). Nothing outside
`radio/` was changed to build this.

## Running it

```
python radio/server.py
```

The first run downloads the prebuilt connectome (~260 MB, once, into
`$FLY_DATA` / `~/fly-data`) if it isn't there already — see
[`flybrain/data.py`](../flybrain/data.py). Needs `numpy`, `scipy`, `numba`
(`pip install -r ../requirements.txt` from this folder).

On startup the server prepares the caption readout before going live: a
fresh calibration takes a minute or two (`--calibration-trials` controls how
many, default 8; more is slower to start but gives better captions), but if
`radio/model/readout.npz` already exists and matches the current settings,
it's reused instead (see "On the site" below; `--no-cache` always
recalibrates without touching the cache, `--recalibrate` forces a fresh run
and overwrites it). Once it prints a URL, open it in a browser (it opens
automatically unless `--no-browser` is passed):

```
python radio/server.py --port 8791 --device cuda --calibration-trials 20
```

Press "Tune in" to power the set on (browsers require a click before audio
can play) — the mic glows, "ON AIR" lights up, and audio/captions start.
Press the same button again ("Turn off") to power it back down cleanly; click
once more to resume. Pick a show with the numbered channel buttons — only one
stream plays at a time, and switching restarts the stream on the new show.
Live captions ("Translation") appear on the right as the station's readout
decodes each on-mic cast member's buzz, newest at the bottom, auto-scrolling
unless you've scrolled up to read back through the log. Stop the server with
Ctrl+C.

## On the site

`docs/*.html` link to Fly Radio the same way they link to Flybook: a "Fly
Radio" entry in the Research dropdown (`docs/research/radio.html`, a
write-up) and a top-level "Radio" link to `/radio/`, the live station.
Unlike Flybook (a separate Vite app built into `.vercel-out/flybook/`),
`/radio/` isn't a static build — `vercel.json`'s `rewrites` proxy
`/radio/*` straight through to wherever `radio/server.py` is actually
running (`https://fly-radio.fly.dev` by default; change the `destination` in
`vercel.json` if you deploy under a different app name), so the same
`radio/site.html` this section describes is what the site serves, unmodified.

**Not costing anything while nobody's listening**, two layers:
- **In-process**: `Studio.loop()` only steps the connectome while at least
  one PCM or captions stream is actually connected
  (`Studio.add_listener`/`remove_listener`, called from the request
  handlers) — pressing "Turn off" or closing the tab drops the connection,
  and the brain pauses within a few seconds, burning no CPU until someone
  tunes back in.
- **Infrastructure**: `radio/fly.toml` sets `auto_stop_machines = "stop"`
  and `min_machines_running = 0`, like `flybook/worker/fly.toml`'s `api`
  process — once every connection is closed, fly.io stops the machine
  entirely, and `auto_start_machines` boots a fresh one on the next request.

**A visitor sees a "warming up" page, not a stalled connection**, while any
of this is happening. `radio/server.py`'s HTTP server binds and starts
answering *before* `Studio()` (the connectome load + readout check) runs —
`StationState` holds the not-yet-ready `Studio`, and every route serves
`WARMUP_PAGE` (a small, auto-refreshing page) until it's set. This matters
most for the fly.io cold-start case above: the first visitor to wake a
stopped machine would otherwise just see a browser connection failure for
however long boot + load takes.

**Cold starts are fast too**: a fresh connectome load still takes a moment,
but the caption readout doesn't recalibrate from scratch every time.
`radio/decode.py`'s `calibrate_cached()` reads a saved readout from
`radio/model/readout.npz` (`radio/model/README.md`) whenever its fingerprint
— `flytalk.CONTEXTS`, `--dt`, `--calibration-trials`, seed, and a manually
bumped `CALIBRATION_VERSION` — still matches, and only pays the 1-2 minute
calibration when something in that fingerprint actually changed (or on the
very first run, which then writes the cache for next time). Mirrors
Flybook's `worker/model/translator.npz`. Generate or refresh it once before
deploying — `radio/deploy.sh` warns if it's missing:

```
python radio/decode.py --cache
```

**Deploying**: `bash radio/deploy.sh` (needs `fly` CLI and a fly.io app
named `fly-radio` in `radio/fly.toml`'s `app`, or edit that name and
`vercel.json`'s rewrite destination to match). No secrets to set. See
`flybook/worker/deploy.sh` for the pattern this mirrors.
