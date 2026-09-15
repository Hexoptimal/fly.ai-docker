# Fly Radio

**A radio station played by an actual fly brain, live, in your browser.** Four shows, five flies, the real
166,700-neuron MaleCNS connectome stepping on the listener's own device. Every buzz you hear is that brain's own
wing-motor-neuron activity, played the instant it's measured: nothing is pre-rendered, nothing loops. Same
"frozen connectome + readout" pattern as [`valentfly/`](../valentfly/) and [`flytalk.py`](../flytalk.py), just
live and audible instead of baked into a report.

Live at [flyaiworld.com/radio/](https://flyaiworld.com/radio/). Research write-up: `docs/research/radio.html`.

## The lineup

Every show reuses one of `flytalk.py`'s already-real stimulus contexts (no new neuron-population mappings invented
here — see `flytalk.CONTEXTS`):

| Show | Cast | Context | What's playing |
|---|---|---|---|
| **White Noise** | Nobody | `baseline` (no stimulus) | Actual hiss, no tone — the resting activity of an undriven fly brain, with the carrier turned off (`tone=0`) so it reads as static rather than a quiet buzz. |
| **Buzzkill** | The Suspect | `threat` (LC4 + LPLC2, looming) | True crime, fly-sized. |
| **Rotten and Tasty** | The Critic | `food` (ORN_DM1 + ORN_DM2) | One fly, one plate, zero chill. |
| **The Mating Call** | Buzzy Buzz (presenter) / Dr. Buzziam Buzz (expert) | `baseline` / `mate` (LC10a) | A talk show: the mic alternates between the two — Buzzy Buzz "asks" for 2.5 s, Dr. Buzziam Buzz "answers" for 4 s, on a loop. Both flies keep running the whole time; only the one on-mic drives that stretch of audio. |

## How it works

**The brain, in the browser.** The page loads the same files the Simulation page uses for Wiz
(`flybrain export --web`: 166,700 neurons, 25.1 M synapses, 58 MB, served from `/simulation/connectome/`) and runs
them in a Web Worker with `world/src/connectome.ts`, the browser port of `FlyBrain(sensory_input=False)`. The
download starts only when a listener presses Tune in, and the brain only steps while the radio is on. It is never
trained and nothing is scripted.

**Stimulus in.** Each cast member of the show you're tuned to is its own copy of the brain, with its show's fixed,
real stimulus injected on every 20 ms step — e.g. The Suspect gets voltage into `LC4`/`LPLC2` (the looming-detection
circuit). Switching shows starts that show's flies from fresh brains, settled for half a second.

**Sound out.** Every step, the page counts that fly's wing motor neurons (`flytalk.WING_MN`, left and right) firing
above their resting level (`flytalk.sound_of()`'s loudness). That one number is the only real ingredient in the
audio: it amplitude-modulates a synthetic ~190 Hz tone so it's audible (`world/src/radio/main.ts`, a 1:1 port of
`radio/audio.py`). The tone, the noise floor and the per-voice pitch are a made-up sonification choice, not a
reconstruction of real wing mechanics. The brain is paced to real time, and the page never queues more than
0.6 s of sound, so audio can't drift behind the brain.

**Text out.** A small classifier (`flybrain.reservoir.Readout`, ridge on PCA of the 1 s loudness envelope) was
calibrated in Python with the same trial loop `flytalk.py` uses (`radio/decode.py`, saved in `radio/model/`) and
exported into the page. Every 2 s of radio it reads the on-mic fly's last second of real envelope — no label
attached — and guesses which context it resembles. It's a genuine decode, not an echo, and it's often wrong:

| Measured | baseline | threat | food | mate |
|---|---|---|---|---|
| Python server, 8 min live (2026-09-15) | 86–100% | 94% | 2% | 0% |
| Browser engine, 6 trials each (Node) | 5/6 | 5/6 | 0/6 | 0/6 |

Threat is loud and distinctive on this connectome; food and mate barely move the wing motor neurons, so they read as
resting. Cross-validated error of the saved readout: 0.157 (always guessing gives 0.1875).

## Files

| File | What it does |
|---|---|
| `channels.py` | The show lineup and cast — imports `flytalk.CONTEXTS` directly. Self-test: `python radio/channels.py`. |
| `audio.py` | Envelope → PCM synthesis, the reference for the page's synth. Self-test: `python radio/audio.py`. |
| `decode.py` | Calibrates the caption readout with `flytalk.speak` and `Readout`; `python radio/decode.py --cache` recalibrates, spot-checks and saves `model/`. |
| `model/` | The calibrated readout (`readout.npz` + `readout.json`). See `model/README.md`. |
| `export_web.py` | Writes the shows, contexts, wing motor neurons and readout into `world/src/radio/radio.json` (4.7 KB), bundled into the page. Re-run after changing `channels.py`, `flytalk.CONTEXTS` or `model/`. |
| `world/radio.html`, `world/src/radio/main.ts` | The page: channel dial, power button, VU meter, translation panel, sound. |
| `world/src/radio/radio.worker.ts` | The brains, the real-time loop, the captions. |
| `world/vite.radio.config.ts` | Builds the page for `/radio/` (`npm run build:radio` in `world/`). |

## Running it locally

```
cd world
npm install
npx vite            # then open http://localhost:5173/radio.html
```

Needs the brain files in `world/public/connectome/` (committed; regenerate with `flybrain export --web
world/public/connectome`). Press Tune in (browsers need a click before audio can play). The nav links point at the
real site's paths, so they only work on the deployed site.

## On the site

`scripts/vercel-build.sh` builds the page with `npm run build:radio` and copies it to `.vercel-out/radio/`, next to
`/simulation/` and `/flybook/`; `vercel.json` redirects `/radio` to `/radio/`. There is no server: deploying the site
deploys the radio.
