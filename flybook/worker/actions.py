"""What a fly did during an episode, read from its descending neurons and wing motor neurons.

Each action is a named neuron group. Its activity in the stimulus window is compared with the
same group in standard flies at rest (nothing happening, no settings). An action counts when the
group is at least Z_MIN standard deviations above rest and at least MIN_EXTRA above the resting
mean. The rest statistics are measured by `fit` when the worker starts, so they always match the
brain it runs. Nothing here decides what a fly does; it only reads what the brain did.
"""
from __future__ import annotations

import math

import numpy as np

from episode import Episodes

Z_MIN = 3.0        # standard deviations above rest
MIN_EXTRA = 3.0    # spikes (or wing spikes/s) above the resting mean
SD_FLOOR = 1.0     # groups that are silent at rest still need a few spikes to count

ACTIONS = [
    {"key": "jumped", "label": "jumped", "groups": ["escape_L", "escape_R"]},
    {"key": "backed_up", "label": "backed up", "groups": ["backward_L", "backward_R"]},
    {"key": "walked", "label": "walked forward", "groups": ["forward_L", "forward_R"]},
    {"key": "turned", "label": "turned", "groups": ["steer_L", "steer_R"]},
    {"key": "groomed", "label": "groomed", "dial": "grooming"},
    # wing motor neurons: they fire with the threat escape too, so this is "buzzed", not courtship song
    {"key": "buzzed", "label": "buzzed its wings", "wings": True},
]

# measured 2026-09-13, 24 standard flies per stimulus (flybook/README.md): nothing 0% any action;
# threat -> jumped 100%, buzzed 100%; mate -> turned 100%; wind -> groomed 100%; touch -> groomed 100%;
# taste and cva -> none.


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

    def values(self, counts: np.ndarray, wing: np.ndarray) -> np.ndarray:
        """(batch, actions): DN spikes per group over the stimulus window, wing spikes/s for sang."""
        return np.column_stack([wing if a.get("wings") else counts[:, self.masks[a["key"]]].sum(1) for a in ACTIONS])

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

    def read(self, counts: np.ndarray, wing: np.ndarray) -> list[list[dict]]:
        """For each fly, the actions it performed as [{key, z, (side)}], strongest first."""
        V = self.values(counts, wing)
        z = (V - self.mean) / self.sd
        out = []
        for i in range(len(V)):
            acts = []
            for j, action in enumerate(ACTIONS):
                if z[i, j] >= Z_MIN and V[i, j] - self.mean[j] >= MIN_EXTRA:
                    item = {"key": action["key"], "z": round(float(z[i, j]), 1)}
                    if action["key"] == "turned":
                        item["side"] = "left" if counts[i, self.left].sum() >= counts[i, self.right].sum() else "right"
                    acts.append(item)
            out.append(sorted(acts, key=lambda a: -a["z"]))
        return out
