"""One Flybook episode: 0.5 s settle, then 1 s with one sense stimulated.

Every fly is the frozen MaleCNS connectome at 20 ms with the sensory fix, one column of a
batched FlyBrain. The words are the senses the pilot sweep (ROADMAP section 10, "More
activity") found readable from the 1,314 descending neurons. The translator is trained on
exactly this episode (calibrate.py), so nothing here may change without recalibrating.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))

from flybrain import FlyBrain  # noqa: E402
from flytalk import WING_MN  # noqa: E402
from settings import DIAL_LEVELS, DIALS, SENSE_OF, clean  # noqa: E402

# word -> sensory cell types driven during the stimulus window
SENSES: dict[str, list[str]] = {
    "nothing": [],
    "threat": ["LC4", "LPLC2"],
    "mate": ["LC10a"],
    "wind": ["JO-CL", "JO-CM", "JO-CA2", "JO-EV1", "JO-EV2", "JO-EV3", "JO-EV5", "JO-EV6",
             "JO-ED1", "JO-ED2_a", "JO-ED2_b", "JO-ED2_c"],
    "taste": ["claw_tpGRN", "dorsal_tpGRN", "BM_Taste"],
    "touch": ["BM_InOm"],
    "cva": ["ORN_DA1"],
}
WARM_S, STIM_S, AMOUNT, DT = 0.5, 1.0, 0.8, 0.020
CONFIG = {"dt": DT, "warm_s": WARM_S, "stim_s": STIM_S, "amount": AMOUNT, "sensory_input": False,
          "senses": SENSES}


def features(counts: np.ndarray) -> np.ndarray:
    """Translator input: log spike counts of every descending neuron."""
    return np.log1p(counts)


class Episodes:
    def __init__(self, batch: int, seed: int = 0, device: str = "cpu"):
        self.brain = b = FlyBrain(device=device, batch=batch, seed=seed, dt=DT, sensory_input=False)
        self.words = list(SENSES)
        self.cells = {w: b.cells(t) for w, t in SENSES.items()}
        self.dn = b.cells(["descending_neuron"])
        self.wing = b.cells(WING_MN)
        self.col = np.full(b.n, -1, np.int64)
        self.col[self.dn] = np.arange(len(self.dn))
        self.col[self.wing] = len(self.dn)                        # all wing motor neurons share one column
        dn_type = b.cell_type[self.dn].astype(str)
        self.types, inverse = np.unique(dn_type, return_inverse=True)
        self.type_matrix = np.zeros((len(self.dn), len(self.types)), np.float32)
        self.type_matrix[np.arange(len(self.dn)), inverse] = 1.0
        self.warm = int(round(WARM_S / DT))
        self.stim = int(round(STIM_S / DT))
        types = np.unique(b.cell_type.astype(str))
        self.dial_cells = {d["key"]: b.cells(d["cells"] + [t for t in types if t.startswith(tuple(d["prefix"]))])
                           for d in DIALS}
        self.base = (float(b.tonic), float(b.gain), float(b.noise_hz))

    def run(self, stimuli: list[str], seed: int, settings: list[dict] | None = None) -> tuple[np.ndarray, np.ndarray]:
        """One word per fly, and optionally one settings dict per fly (see settings.py). Returns DN
        spike counts (batch, n_dn) over the stimulus window and wing motor neuron spikes/s (batch,)."""
        b = self.brain
        if len(stimuli) != b.batch:
            raise ValueError(f"{len(stimuli)} stimuli for a batch of {b.batch}")
        tuned = [clean(s) for s in (settings or [{}] * b.batch)]
        if len(tuned) != b.batch:
            raise ValueError(f"{len(tuned)} settings for a batch of {b.batch}")
        b.reset(seed)
        inject, dials = self.configure(tuned, [(w, 1.0) for w in stimuli])
        acc = np.zeros((b.batch, len(self.dn) + 1))
        for s in range(self.warm + self.stim):
            fired = b.step(inject=dials + (inject if s >= self.warm else []))
            if s < self.warm:
                continue
            for i, f in enumerate([fired] if b.batch == 1 else fired):
                c = self.col[f]
                np.add.at(acc[i], c[c >= 0], 1)
        return acc[:, :-1], acc[:, -1] / (self.stim * DT)

    def configure(self, tuned: list[dict], direct: list[tuple[str | None, float]]) -> tuple[list, list]:
        """Apply each fly's temperament to the brain and build its per-step injections: the stimulus
        (word, strength 0..1, scaled by the fly's sense setting) and the neuron-group dials."""
        b = self.brain
        # temperament: per-fly copies of the brain's global constants, shaped to broadcast over (n, batch)
        scale = lambda key: np.array([t["temperament"].get(key, 1.0) for t in tuned])
        tonic, gain, noise = self.base
        b.tonic = (tonic * scale("excitability")).reshape(1, -1)
        b.gain = (gain * scale("wiring")).astype(np.float32).reshape(1, -1)
        b.noise_hz = (noise * scale("restlessness")).reshape(1, -1)
        words = [w for w in dict.fromkeys(w for w, _ in direct) if w]
        inject = [(self.cells[w], np.array([AMOUNT * t["senses"].get(SENSE_OF.get(w, ""), 1.0) * k if dw == w else 0.0
                                            for (dw, k), t in zip(direct, tuned)], np.float32))
                  for w in words if len(self.cells[w])]
        dials = [(self.dial_cells[d["key"]], amount) for d in DIALS
                 if (amount := np.array([DIAL_LEVELS[t["dials"].get(d["key"], "normal")] for t in tuned], np.float32)).any()]
        return inject, dials

    def type_counts(self, counts: np.ndarray) -> np.ndarray:
        return counts @ self.type_matrix

    def cite(self, counts: np.ndarray, mean: np.ndarray, sd: np.ndarray, top: int = 5, min_z: float = 2.0) -> list[dict]:
        """The DN types that moved most against the resting brain, as {type, z}."""
        z = (self.type_counts(counts) - mean) / np.maximum(sd, 1.0)
        order = np.argsort(-np.abs(z))[:top]
        return [{"type": str(self.types[i]), "z": round(float(z[i]), 1)} for i in order if abs(z[i]) >= min_z]
