"""Turn a wing-motor-neuron loudness envelope into audible PCM.

Only the envelope (amplitude, over time) is measured: wing-MN spikes above
rest, exactly `flytalk.sound_of()`'s "song" loudness, one real number per
simulation step. Everything else here -- the ~190 Hz sine carrier standing in
for a wingbeat tone, the per-voice pitch tweak, the noise floor -- is a
sonification choice, not a reconstruction of real wing mechanics. Made up,
plainly, same spirit as valentfly's own "Made up, plainly" section.

ENVELOPE_GAIN was hand-tuned from one short calibration run (see radio/README.md):
rest-subtracted wing loudness over the 4 real contexts came out with means
around 0.8-1.8 spikes/step and occasional bursts to ~15-17; 0.4 puts typical
activity in a comfortably audible range while letting bursts saturate (a
buzzier texture) instead of clipping into a flat wall of noise.

    python radio/audio.py   # self-test, no brain needed
"""
from __future__ import annotations

import numpy as np

CARRIER_HZ = 190.0        # roughly a fly's wingbeat frequency
ENVELOPE_GAIN = 0.4        # measured loudness units -> pre-clip amplitude scale
LEVEL_SMOOTH = 0.3         # how fast the chunk-to-chunk "loudness trend" follows the envelope


class Voice:
    """Continuous per-cast-member synthesis state (carrier phase, smoothed
    loudness trend) so consecutive chunks don't click at their boundaries.

    `tone`: how much of the ~190 Hz sine carrier to mix in, 0..1. At the
    default 1.0 a cast member sounds like a buzz; at 0.0 the carrier drops
    out entirely and only noise (still amplitude-driven by the same real
    envelope) remains -- radio static, for a column with nothing to say."""

    def __init__(self, pitch: float = 1.0, tone: float = 1.0):
        self.pitch = pitch
        self.tone = tone
        self.phase = 0.0
        self.level = 0.0

    def synthesize(self, envelope_steps: np.ndarray, dt: float, sample_rate: int,
                    noise: float, rng: np.random.Generator) -> np.ndarray:
        """envelope_steps: loudness (>= 0) per simulation step, covering one chunk.
        Returns int16 PCM samples for that chunk (mono)."""
        envelope_steps = np.asarray(envelope_steps, np.float32)
        n_samples = int(round(len(envelope_steps) * dt * sample_rate))
        if n_samples <= 0 or len(envelope_steps) == 0:
            return np.zeros(0, np.int16)

        step_t = np.arange(len(envelope_steps)) * dt
        sample_t = np.arange(n_samples) / sample_rate
        raw = np.interp(sample_t, step_t, envelope_steps,
                         left=envelope_steps[0], right=envelope_steps[-1])

        target = float(np.clip(envelope_steps.mean() * ENVELOPE_GAIN, 0.0, 1.0))
        self.level += (target - self.level) * LEVEL_SMOOTH
        amp = np.clip(raw * ENVELOPE_GAIN, 0.0, 1.0) * 0.5 + self.level * 0.5

        freq = CARRIER_HZ * self.pitch
        phase = self.phase + 2 * np.pi * freq * sample_t
        wave = np.sin(phase) * amp * self.tone
        wave += rng.normal(0.0, noise, n_samples) * (0.3 + 0.7 * amp)
        self.phase = float((phase[-1] + 2 * np.pi * freq / sample_rate) % (2 * np.pi))

        return np.clip(wave * 32000.0, -32768, 32767).astype(np.int16)


def mix_turns(speaker_index: int, envelopes: list[np.ndarray]) -> np.ndarray:
    """For a multi-member show: only the on-mic member's envelope drives sound
    this chunk. The other member's brain keeps running (state still carries),
    it just isn't the one you hear."""
    return envelopes[speaker_index]


def to_bytes(pcm: np.ndarray) -> bytes:
    return pcm.astype("<i2").tobytes()


def silence_bytes(dt: float, steps: int, sample_rate: int) -> bytes:
    n_samples = int(round(steps * dt * sample_rate))
    return np.zeros(n_samples, "<i2").tobytes()


if __name__ == "__main__":
    rng = np.random.default_rng(0)
    dt, sr = 0.020, 22050

    voice = Voice(pitch=1.0)
    loud = np.abs(np.sin(np.linspace(0, 3.14, 5))) * 3.0  # fake envelope: one 100 ms chunk (5 steps)
    pcm = voice.synthesize(loud, dt, sr, noise=0.02, rng=rng)
    assert len(pcm) == round(5 * dt * sr), len(pcm)
    assert pcm.dtype == np.int16
    assert np.abs(pcm).max() > 0, "expected audible output, got silence"
    assert np.abs(pcm).max() <= 32767

    quiet = voice.synthesize(np.zeros(5, np.float32), dt, sr, noise=0.0, rng=rng)
    assert np.abs(quiet).max() < np.abs(pcm).max(), "silence should be quieter than a loud chunk"

    silent_voice = Voice(pitch=1.0, tone=0.0)
    truly_quiet = silent_voice.synthesize(loud, dt, sr, noise=0.0, rng=rng)
    assert np.abs(truly_quiet).max() == 0, "tone=0 with no noise should be dead silent (no carrier leaking through)"
    static_voice = Voice(pitch=1.0, tone=0.0)
    hiss = static_voice.synthesize(loud, dt, sr, noise=0.3, rng=rng)
    assert np.abs(hiss).max() > 0, "tone=0 should still pass real noise through"

    picked = mix_turns(1, [np.zeros(3), np.ones(3)])
    assert np.all(picked == 1)
    picked0 = mix_turns(0, [np.full(3, 5.0), np.zeros(3)])
    assert np.all(picked0 == 5.0)

    assert to_bytes(np.array([0, 1, -1], np.int16)) == np.array([0, 1, -1], "<i2").tobytes()
    assert len(silence_bytes(dt, 5, sr)) == round(5 * dt * sr) * 2

    print(f"self-test OK: {len(pcm)} samples/chunk, peak {int(np.abs(pcm).max())}/32767")
