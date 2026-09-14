"""What a fly did during an episode, read from its descending neurons and wing motor neurons.

Each action is a named neuron group. Its activity in the stimulus window is compared with the
same group at rest (nothing happening). An action counts when the group is at least Z_MIN standard
deviations above rest and at least MIN_EXTRA above the resting mean. Nothing here decides what a
fly does; it only reads what the brain did.

Two resting baselines:
  standard  flies with no settings, measured by `fit` when the worker starts (readout.py, replay flags)
  own       flies with one fly's own settings, measured by `fit_profiles` (the live tick). Added 2026-09-14:
            live posts judged against the standard fly showed settings, not events. The Grooming dial pushes
            the very DNg12 cells read as 'groomed' (100% of resting flies with it boosted 'groomed'), and
            restless, excitable flies 'buzzed' and 'turned' at rest (83-100%). Against rest measured with the
            fly's own settings, held-out resting flies showed each action 0-17% of the time.
The turn side compares each DNa02 (one neuron per side) with its own resting rate: the left one fires more
at rest (about 2.7 vs 1.8 spikes in restless flies), and ties used to count as left.
"""
from __future__ import annotations

import json
import math

import numpy as np

from episode import Episodes
from settings import clean

Z_MIN = 3.0        # standard deviations above rest
MIN_EXTRA = 3.0    # spikes (or wing spikes/s) above the resting mean
SD_FLOOR = 1.0     # groups that are silent at rest still need a few spikes to count
SIDE_MIN = 1.0     # spikes above rest one DNa02 must lead the other by to name a turn's side
PROFILE_SAMPLES = 12   # resting flies measured per settings profile

ACTIONS = [
    {"key": "jumped", "label": "jumped", "groups": ["escape_L", "escape_R"]},
    {"key": "backed_up", "label": "backed up", "groups": ["backward_L", "backward_R"]},
    {"key": "walked", "label": "walked forward", "groups": ["forward_L", "forward_R"]},
    {"key": "turned", "label": "turned", "groups": ["steer_L", "steer_R"]},
    {"key": "groomed", "label": "groomed", "dial": "grooming"},
    # wing motor neurons: they fire with the threat escape too, so this is "buzzed", not courtship song
    {"key": "buzzed", "label": "buzzed its wings", "wings": True},
]
TURNED = [a["key"] for a in ACTIONS].index("turned")

# measured 2026-09-13, 24 standard flies per stimulus (flybook/README.md): nothing 0% any action;
# threat -> jumped 100%, buzzed 100%; mate -> turned 100%; wind -> groomed 100%; touch -> groomed 100%;
# taste and cva -> none.


def profile_key(settings: dict | None) -> str:
    """Flies with the same cleaned settings share one resting baseline."""
    return json.dumps(clean(settings or {}), sort_keys=True)


class ActionReader:
    def __init__(self, eps: Episodes):
        self.eps = eps
        brain = eps.brain
        self.masks: dict[str, np.ndarray] = {}
        for action in ACTIONS:
            if action.get("wings"):
                continue
            ids = eps.dial_cells[action["dial"]] if "dial" in action else np.concatenate([brain.groups[g] for g in action["groups"]])
            self.masks[action["key"]] = np.isin(eps.dn, ids)
        self.left = np.isin(eps.dn, brain.groups["steer_L"])
        self.right = np.isin(eps.dn, brain.groups["steer_R"])
        self.mean: np.ndarray | None = None
        self.sd: np.ndarray | None = None
        self.own: dict[str, tuple[np.ndarray, np.ndarray]] = {}   # profile key -> (mean, sd) over values_sided columns

    def values(self, counts: np.ndarray, wing: np.ndarray) -> np.ndarray:
        """(batch, actions): DN spikes per group over the stimulus window, wing spikes/s for buzzed."""
        return np.column_stack([wing if a.get("wings") else counts[:, self.masks[a["key"]]].sum(1) for a in ACTIONS])

    def values_sided(self, counts: np.ndarray, wing: np.ndarray) -> np.ndarray:
        """values() plus left and right DNa02 spikes as two extra columns."""
        return np.column_stack([self.values(counts, wing), counts[:, self.left].sum(1), counts[:, self.right].sum(1)])

    def fit(self, episodes: int = 48, seed: int = 777_000) -> dict:
        """Resting statistics from standard flies with nothing happening."""
        B = self.eps.brain.batch
        rows = []
        for r in range(math.ceil(episodes / B)):
            counts, wing = self.eps.run(["nothing"] * B, seed=seed + r)
            rows.append(self.values(counts, wing))
        return self.fit_values(np.vstack(rows))

    def fit_values(self, X: np.ndarray) -> dict:
        """Resting statistics from rows of values() (readout.py passes flies in a patch that had nothing happen)."""
        self.mean, self.sd = X.mean(0), np.maximum(X.std(0), SD_FLOOR)
        self.rest = {a["key"]: {"mean": round(float(m), 2), "sd": round(float(s), 2)} for a, m, s in zip(ACTIONS, self.mean, self.sd)}
        return self.rest

    def use(self, rest: dict) -> dict:
        """Resting statistics saved in model/vocab.json by readout.py, instead of fitting at startup."""
        self.mean = np.array([rest[a["key"]]["mean"] for a in ACTIONS], float)
        self.sd = np.maximum(np.array([rest[a["key"]]["sd"] for a in ACTIONS], float), SD_FLOOR)
        self.rest = rest
        return rest

    def missing(self, settings: list[dict]) -> list[str]:
        """Profile keys among `settings` with no resting baseline yet, in first-seen order."""
        return [k for k in dict.fromkeys(profile_key(s) for s in settings) if k not in self.own]

    def fit_profiles(self, keys: list[str], seed: int, samples: int = PROFILE_SAMPLES) -> None:
        """Measure `samples` resting flies (alone, nothing happening) for each profile key. Profiles share
        batch columns, so the cost is about samples * len(keys) / batch episodes."""
        B = self.eps.brain.batch
        order = [k for k in keys for _ in range(samples)]
        rows: dict[str, list] = {k: [] for k in keys}
        for r in range(0, len(order), B):
            part = order[r:r + B]
            fill = part + [part[-1]] * (B - len(part))
            counts, wing = self.eps.run(["nothing"] * B, seed=seed + r, settings=[json.loads(k) for k in fill])
            V = self.values_sided(counts, wing)
            for i, k in enumerate(part):
                rows[k].append(V[i])
        for k, vs in rows.items():
            X = np.array(vs)
            self.own[k] = (X.mean(0), np.maximum(X.std(0), SD_FLOOR))

    def read(self, counts: np.ndarray, wing: np.ndarray, profiles: list[str] | None = None) -> list[list[dict]]:
        """For each fly, the actions it performed as [{key, z, (side)}], strongest first.
        profiles: each fly's profile key, judged against its own rest (a fly whose profile has no baseline
        yet reads no actions); None judges every fly against the standard rest."""
        V = self.values_sided(counts, wing)
        n = len(ACTIONS)
        out = []
        for i in range(len(V)):
            if profiles is None:
                mean = np.concatenate([self.mean, [np.nan, np.nan]])
                sd = np.concatenate([self.sd, [np.nan, np.nan]])
            elif profiles[i] in self.own:
                mean, sd = self.own[profiles[i]]
            else:
                out.append([])
                continue
            z = (V[i, :n] - mean[:n]) / sd[:n]
            acts = []
            for j, action in enumerate(ACTIONS):
                if z[j] >= Z_MIN and V[i, j] - mean[j] >= MIN_EXTRA:
                    item = {"key": action["key"], "z": round(float(z[j]), 1)}
                    if j == TURNED:
                        if profiles is None:
                            left, right = V[i, n], V[i, n + 1]
                        else:                       # each side against its own resting rate
                            left, right = V[i, n] - mean[n], V[i, n + 1] - mean[n + 1]
                        if abs(left - right) >= SIDE_MIN:
                            item["side"] = "left" if left > right else "right"
                    acts.append(item)
            out.append(sorted(acts, key=lambda a: -a["z"]))
        return out
