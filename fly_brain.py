"""Leaky integrate-and-fire simulation of the MaleCNS connectome.

Dynamics follow ornata/fly (fly64/model.py) so results are comparable:
    v <- exp(-dt/tau) v + gain * W @ spikes + tonic + noise + eye input
    v >= 1 -> spike, reset to 0
tonic/gain/noise are hand-calibrated, not measured. fly64 used tonic 0.18,
gain 1.5, which parks every neuron at threshold (0.18 / (1 - 0.82) = 1.0) so
the network ticks on its own. inject.py showed tonic 0.14, gain 3.0 keeps
descending neurons quiet at rest (~1 Hz) while LC4/LPLC2 -> DNp01 and
LC10a -> DNa02 signals still get through, ipsilaterally.
"""
from __future__ import annotations

import os
from pathlib import Path

import numba
import numpy as np
from scipy import sparse

DATA = Path(os.environ.get("FLY_DATA", Path.home() / "fly-data"))


@numba.njit(nogil=True, parallel=True)
def _propagate(indptr, indices, weights, fired, n):
    """Sum the outgoing weights (CSC columns) of every neuron that spiked.
    Each thread scatters into its own buffer; buffers are summed at the end."""
    threads = numba.get_num_threads()
    partial = np.zeros((threads, n), np.float32)
    chunk = (len(fired) + threads - 1) // threads
    for t in numba.prange(threads):
        acc = partial[t]
        for k in range(t * chunk, min(len(fired), (t + 1) * chunk)):
            j = fired[k]
            for e in range(indptr[j], indptr[j + 1]):
                acc[indices[e]] += weights[e]
    current = np.zeros(n, np.float32)
    for i in numba.prange(n):
        s = np.float32(0.0)
        for t in range(threads):
            s += partial[t, i]
        current[i] = s
    return current


class FlyBrain:
    dt = 0.020
    tau = 0.100
    gain = 3.0
    tonic = 0.14
    noise_hz = 1.2
    noise_amp = 0.22
    eye_gain = 0.62

    def __init__(self, data: Path = DATA, seed: int = 64):
        W = sparse.load_npz(data / "weights.npz").tocsc()
        self.n = W.shape[0]
        self.indptr, self.indices, self.weights = W.indptr, W.indices, W.data
        meta = np.load(data / "brain.npz")
        self.visual = meta["visual"]
        self.azimuth = meta["azimuth"]  # -1 far left ... +1 far right
        self.cell_type = meta["cell_type"]
        self.side = meta["side"]
        self.positions = meta["positions"] if "positions" in meta.files else None
        self.groups = {k.removeprefix("group_"): meta[k] for k in meta.files if k.startswith("group_")}
        self.rng = np.random.default_rng(seed)
        self.decay = np.float32(np.exp(-self.dt / self.tau))
        self.v = np.zeros(self.n, np.float32)
        self.fired = np.empty(0, np.int64)
        self.steps = 0

    def cells(self, types: list[str], side: str | None = None) -> np.ndarray:
        mask = np.isin(self.cell_type, types)
        if side:
            mask &= self.side == side
        return np.flatnonzero(mask)

    def synaptic_input(self, fired: np.ndarray) -> np.ndarray:
        return _propagate(self.indptr, self.indices, self.weights, fired, self.n)

    def step(self, eye_drive: np.ndarray | None = None, inject=()) -> np.ndarray:
        """Advance 20 ms. eye_drive: 0..1 per photoreceptor (len(self.visual));
        inject: (neuron indices, extra voltage) pairs added this step."""
        current = self.synaptic_input(self.fired) * self.gain
        self.v *= self.decay
        self.v += current + self.tonic
        self.v += (self.rng.random(self.n) < self.noise_hz * self.dt) * np.float32(self.noise_amp)
        if eye_drive is not None:
            self.v[self.visual] += eye_drive.astype(np.float32) * self.eye_gain
        for idx, amount in inject:
            self.v[idx] += np.float32(amount)
        fired = np.flatnonzero(self.v >= 1.0)
        self.v[fired] = 0.0
        self.fired = fired
        self.steps += 1
        return fired
