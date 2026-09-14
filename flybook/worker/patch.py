"""Flies in a patch affect each other: one shared run where what each fly's brain does becomes
sensory input for its neighbours on the next 20 ms step.

What a neighbour can cause, and what drives it (fixed rules, not tuned to an outcome):
  loom    its giant-fibre escape neurons burst (>= BURST spikes in the last LOOK steps)
          -> looming detectors (LC4, LPLC2), a full-strength looming stimulus for a fly right next to it
  target  its walking or steering neurons burst the same way -> moving-target detectors (LC10a)
  bump    it comes within BUMP_R               -> face bristles (BM_InOm) of both flies
Strength falls off as exp(-distance / REACH) and is capped at one direct stimulus (AMOUNT).

The burst rule was added after the first measurement (2026-09-13): with single spikes counting, one
resting giant-fibre spike set off every fly in the patch even when nothing happened (neighbours jumped
100% in the no-event condition). A threatened fly bursts about 9 escape spikes per 100 ms; at rest the
expected count is about 0.06. Pass rule, fixed before rerunning: with no event, neighbours must stay
near their isolated resting rate (at most 5% doing anything). Rerun: 5%, passed, but 54 of 56 quiet neighbours
were labelled 'heard wings'. Tracing one quiet patch showed why: resting wing motor neurons fire in synchronous
volleys (mean ~1 spike per step, single steps up to 15-20), so 200 ms windows at rest reach 26-30 spikes, more
than a threatened fly's ~23. At 20 ms a neighbour's ears can't tell rest from buzzing, so there is no sound
channel. Flies already touching when a tick starts don't count as bumping (they did at first).
The first body hopped on every escape spike, so a threatened fly crossed the whole patch in a second and left
its neighbours' range; it now hops once per escape burst, then waits HOP_REST steps.
Labels: SOCIAL_MIN was 0.2 at first, but live posts showed flies jumping after a neighbour's jump with a
peak input between 0.02 and 0.2 and being labelled 'hallucination' or 'on its own'. Any neighbour input of
2% of a direct stimulus or more now counts as what happened (labels only; behaviour is unchanged).

The body is a toy, stated as such: the patch is a 1 x 1 square, heading turns with left-minus-right
steering spikes, the fly steps with forward-minus-backward walking spikes, and hops forward when the
giant fibre fires. Nothing here decides what a fly does; the brain's own spikes move it.
"""
from __future__ import annotations

import numpy as np

from actions import ActionReader
from episode import AMOUNT, DT, Episodes
from settings import clean

REACH = 0.2          # patch units; influence at distance d is exp(-d / REACH)
LOOK, BURST = 5, 3   # a jump or a move is BURST+ spikes within the last LOOK steps (100 ms)
BUMP_R = 0.06        # closer than this counts as a bump
LINK_MIN = 0.05      # per-step input from one neighbour worth drawing as a link in the replay
SOCIAL_MIN = 0.02    # peak per-step input that counts as "really happened" to a fly (2% of a direct stimulus)
TURN, STEP, HOP = 0.25, 0.012, 0.12   # radians per net steering spike, units per walking spike, units per hop
HOP_REST = 12        # steps (240 ms) before a fly can hop again
FRAME_EVERY = 3      # steps per replay frame
CHANNELS = ["loom", "target", "bump"]
WORD_OF = {"loom": "threat", "target": "mate", "bump": "touch"}

# per-neuron group ids for per-step counting
ESCAPE, FORWARD, BACKWARD, STEER_L, STEER_R, WING, GROOM = range(7)
# names of those groups, in that order, as stored in a post's `trace` (the app plays it as the fly's voice)
TRACE_GROUPS = ["escape", "forward", "backward", "steer_left", "steer_right", "wing", "groom"]


class PatchRunner:
    def __init__(self, eps: Episodes, reader: ActionReader):
        self.eps = eps
        brain = eps.brain
        self.cells = {"loom": brain.cells(["LC4", "LPLC2"]), "target": brain.cells(["LC10a"]), "bump": brain.cells(["BM_InOm"])}
        self.gid = np.full(brain.n, -1, np.int64)
        for gid, ids in ((ESCAPE, np.concatenate([brain.groups["escape_L"], brain.groups["escape_R"]])),
                         (FORWARD, np.concatenate([brain.groups["forward_L"], brain.groups["forward_R"]])),
                         (BACKWARD, np.concatenate([brain.groups["backward_L"], brain.groups["backward_R"]])),
                         (STEER_L, brain.groups["steer_L"]), (STEER_R, brain.groups["steer_R"]),
                         (WING, eps.wing), (GROOM, eps.dial_cells["grooming"])):
            self.gid[ids] = gid
        self.n_escape = max(1, int((self.gid == ESCAPE).sum()))
        self.wing_rest = reader.rest["buzzed"]["mean"] * DT                 # wing spikes per step at rest
        self.groom_rest = reader.rest["groomed"]["mean"] / eps.stim          # grooming DN spikes per step at rest

    def run(self, direct: list[tuple[str | None, float]], positions: np.ndarray, patch_of: list[str | None],
            settings: list[dict], seed: int, ramp: bool = False) -> dict:
        """direct: (word, strength 0..1) per fly for the patch's own event or a poke; positions: (batch, 3)
        x, y, heading; patch_of: patch id per fly (None for padding: never coupled); ramp: the direct stimulus
        grows linearly from nothing to full strength over the window (duels)."""
        eps, brain = self.eps, self.eps.brain
        B = len(direct)
        if not 1 <= B <= eps.max_batch:
            raise ValueError(f"{B} flies for a brain of at most {eps.max_batch}")
        brain.batch = B                                   # exactly these flies, no padding columns
        tuned = [clean(s) for s in settings]
        brain.reset(seed)
        stimulus, dials = eps.configure(tuned, direct)
        pos = np.array(positions, dtype=float)
        same = np.array([[pi is not None and pi == pj and i != j for j, pj in enumerate(patch_of)]
                         for i, pi in enumerate(patch_of)])
        acc = np.zeros((B, len(eps.dn) + 1))
        social = np.zeros((B, len(CHANNELS)))
        peak = np.zeros((B, len(CHANNELS)))
        source = np.zeros((B, len(CHANNELS), B))
        pending = np.zeros((B, len(CHANNELS)), np.float32)
        links: dict[tuple[int, int, str], int] = {}
        frames = []
        start = np.hypot(pos[:, None, 0] - pos[None, :, 0], pos[:, None, 1] - pos[None, :, 1])
        close_before = (start < BUMP_R) & same           # already touching at the start is not a bump
        escape_recent = np.zeros((B, LOOK))
        move_recent = np.zeros((B, LOOK))
        last_hop = np.full(B, -10**6)
        first_hop = np.full(B, -1)
        trace = np.zeros((B, eps.stim, len(TRACE_GROUPS)), np.int32)   # spikes per group per stimulus step

        for s in range(eps.warm + eps.stim):
            live = s >= eps.warm
            inject = list(dials)
            if live:
                grow = (s - eps.warm + 1) / eps.stim if ramp else 1.0
                inject += [(cells, amount * np.float32(grow)) for cells, amount in stimulus]
                inject += [(self.cells[ch], pending[:, c].copy()) for c, ch in enumerate(CHANNELS) if pending[:, c].any()]
            fired = brain.step(inject=inject)
            G = np.zeros((B, 7))
            for i, f in enumerate([fired] if B == 1 else fired):
                g = self.gid[f]
                G[i] = np.bincount(g[g >= 0], minlength=7)[:7]
                if live:
                    col = eps.col[f]
                    np.add.at(acc[i], col[col >= 0], 1)

            escape_recent[:, s % LOOK] = G[:, ESCAPE]
            hop = (escape_recent.sum(1) >= BURST) & (s - last_hop > HOP_REST)
            last_hop[hop] = s
            first_hop[hop & (first_hop < 0) & live] = s - eps.warm
            pos[:, 2] += TURN * (G[:, STEER_L] - G[:, STEER_R])
            stride = STEP * (G[:, FORWARD] - G[:, BACKWARD]) + HOP * hop
            pos[:, 0] = np.clip(pos[:, 0] + stride * np.cos(pos[:, 2]), 0.03, 0.97)
            pos[:, 1] = np.clip(pos[:, 1] + stride * np.sin(pos[:, 2]), 0.03, 0.97)
            move_recent[:, s % LOOK] = G[:, FORWARD] + G[:, BACKWARD] + G[:, STEER_L] + G[:, STEER_R]
            if not live:
                continue
            trace[:, s - eps.warm] = G

            dist = np.hypot(pos[:, None, 0] - pos[None, :, 0], pos[:, None, 1] - pos[None, :, 1])
            near = np.exp(-dist / REACH) * same
            close = (dist < BUMP_R) & same
            signal = {
                "loom": (escape_recent.sum(1) >= BURST).astype(float),
                "target": (move_recent.sum(1) >= BURST).astype(float),
            }
            for c, ch in enumerate(CHANNELS):
                contrib = (close & ~close_before).astype(float) if ch == "bump" else near * signal[ch][None, :]
                amount = AMOUNT * np.minimum(1.0, contrib.sum(1))           # next step's input to each receiver
                pending[:, c] = amount
                social[:, c] += amount
                peak[:, c] = np.maximum(peak[:, c], amount)
                source[:, c, :] += contrib
                for i, j in zip(*np.nonzero(AMOUNT * contrib >= LINK_MIN)):
                    links.setdefault((int(j), int(i), ch), s - eps.warm)
            close_before = close
            if (s - eps.warm) % FRAME_EVERY == 0:
                flags = ((G[:, ESCAPE] > 0) * 1 + (G[:, WING] > self.wing_rest + 3) * 2
                         + (G[:, GROOM] > self.groom_rest + 3) * 4)
                frames.append([[round(float(x), 3), round(float(y), 3), round(float(h) % (2 * np.pi), 2), int(fl)]
                               for (x, y, h), fl in zip(pos, flags)])

        return {
            "counts": acc[:, :-1], "wing": acc[:, -1] / (eps.stim * DT),
            "social": social, "peak": peak, "source": source, "positions": pos, "frames": frames,
            "first_hop": [None if h < 0 else int(h) for h in first_hop],
            "trace": trace,
            "links": [{"from": j, "to": i, "channel": ch, "step": st}
                      for (j, i, ch), st in sorted(links.items(), key=lambda kv: kv[1])],
        }

    def cause(self, result: dict, i: int, rule: dict | None = None) -> dict | None:
        """The strongest thing neighbours did to fly i, if it reached the label rule: {channel, from, strength}.
        rule: {"kind": "peak" | "total", "threshold"} from the model's vocab.json (labels.py); default is a peak of
        SOCIAL_MIN on one step. "total" is the input summed over the window as a share of a full direct stimulus."""
        kind, threshold = (rule["kind"], float(rule["threshold"])) if rule else ("peak", SOCIAL_MIN)
        value = result["peak"] if kind == "peak" else result["social"] / (AMOUNT * self.eps.stim)
        reached = [c for c in range(len(CHANNELS)) if value[i, c] >= threshold]
        if not reached:
            return None
        c = max(reached, key=lambda c: result["social"][i, c])
        return {"channel": CHANNELS[c], "from": int(np.argmax(result["source"][i, c])),
                "strength": round(float(result["peak"][i, c]), 2)}
