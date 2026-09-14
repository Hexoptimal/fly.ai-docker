"""The same connectome model as flybrain.FlyBrain, with a cheaper CPU step for the throttled worker machine.

Why (2026-09-14): the tick machine is a fly.io shared CPU, held to 6.25% of a core once its burst runs out, so a
tick took 150-350 s for 17 flies against 5.7 s per batch-12 episode on a desktop. What costs CPU per 20 ms step at
batch 12 (desktop, 2 threads): spike propagation 64% (one parallel numba call per fly, each allocating per-thread
buffers, then stacked), noise 16% (a uniform draw for every neuron of every fly), decay/tonic 10%.

What changes, not the model:
  propagation  one single-threaded pass over all flies' spikes into a reused (n, batch) buffer: same sums
  noise        each neuron of each fly still fires a noise kick with probability noise_hz * dt, independently.
               Drawn as a binomial count per fly, then that many distinct neurons chosen uniformly: the same
               distribution as comparing n uniforms with p, with far fewer random numbers. The noise stream
               differs, so individual spikes differ, as between flybrain's CPU and GPU devices.
  batch        may change between runs (set `batch` before reset); the worker sizes each batch to its flies
               instead of padding to 12.
Equivalence was checked before deploying against pre-set criteria (flybook/README.md, "Faster ticks").
"""
from __future__ import annotations

import numba
import numpy as np
from flybrain import FlyBrain


@numba.njit(nogil=True, cache=True)
def _propagate_all(indptr, indices, weights, fired, batch, out):
    """out[i, b] = sum of weights from every neuron that fired in fly b onto neuron i. `fired` are flat
    indices into an (n, batch) array (neuron * batch + fly)."""
    out[:] = 0.0
    for k in range(fired.shape[0]):
        j = fired[k] // batch
        b = fired[k] % batch
        for e in range(indptr[j], indptr[j + 1]):
            out[indices[e], b] += weights[e]


class FastBrain(FlyBrain):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._current: np.ndarray | None = None

    def synaptic_input(self, fired):
        if self.device != "cpu":
            return super().synaptic_input(fired)
        if self._current is None or self._current.shape != (self.n, self.batch):
            self._current = np.empty((self.n, self.batch), np.float32)
        _propagate_all(self.indptr, self.indices, self.weights, np.asarray(fired, np.int64), self.batch, self._current)
        return self._current

    def _noise(self) -> None:
        """Add noise_amp to each neuron of each fly with probability noise_hz * dt (per fly when temperament
        sets noise_hz per fly)."""
        B, n = self.batch, self.n
        p = np.broadcast_to(np.asarray(self.noise_hz * self.dt, float).reshape(-1), (B,))
        amp = np.float32(self.noise_amp)
        counts = self.rng.binomial(n, np.clip(p, 0.0, 1.0))
        flat = self.v.reshape(-1)
        for b in range(B):
            if counts[b]:
                rows = self.rng.choice(n, size=int(counts[b]), replace=False, shuffle=False)
                flat[rows * B + b] += amp

    def step(self, eye_drive: np.ndarray | None = None, inject=()):
        if self.device != "cpu":
            return super().step(eye_drive, inject)
        B = self.batch
        current = self.synaptic_input(self.fired)
        current *= np.float32(self.gain) if np.ndim(self.gain) == 0 else self.gain
        current += self.tonic
        self.v *= self.decay
        self.v += current
        self._noise()
        if eye_drive is not None:
            drive = np.asarray(eye_drive, dtype=np.float32)
            self.v[self._visual] += (drive[:, None] if drive.ndim == 1 else drive) * self.eye_gain
        for idx, amount in inject:
            self.v[np.asarray(idx)] += self._amount(amount)
        if self.refractory_steps:
            self.v[(self.steps - self.last_spike) <= self.refractory_steps] = 0.0
        fired = np.flatnonzero(self.v >= 1.0)
        self.v.reshape(-1)[fired] = 0.0
        if self.refractory_steps:
            self.last_spike.reshape(-1)[fired] = self.steps
        self.fired = fired
        self.steps += 1
        if B == 1:
            return fired
        rows, cols = np.divmod(fired, B)
        order = np.argsort(cols, kind="stable")
        return np.split(rows[order], np.cumsum(np.bincount(cols, minlength=B))[:-1])
