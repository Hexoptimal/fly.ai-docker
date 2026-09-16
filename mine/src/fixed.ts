/**
 * The integer brain: the arithmetic the mining engine runs, so JavaScript on any CPU and WGSL on any GPU
 * give the same spikes bit for bit. Floats can't promise that across GPU drivers, and a spiking network
 * turns one flipped threshold into a different spike train within a few steps.
 *
 *   voltage  Q16: 1.0 = 65536; a spike at >= 65536, then reset to 0
 *   synapse  Q20 weight, inputs summed with 32-bit wraparound, so the order of summing never matters
 *   update   v <- mulshift16(v, decay) + mulshift16(input, gain_q12) + tonic + drive + noise
 *   noise    a hash of (neuron, step key) under a threshold, so every neuron draws independently
 *   record   each spike adds hash(neuron, step key) into two 32-bit sums: order-free, CPU and GPU alike
 *
 * Every operation wraps at 32 bits exactly as WGSL i32/u32 do. Real activity stays far inside the range
 * (voltages about -8..1, inputs under 5), so wraparound only pins the result down; it doesn't happen.
 *
 * The same model as world/src/connectome.ts up to rounding and the noise stream; src/validate.ts compares them.
 */
import type { TaskParams } from "./runner.ts";

export const V_ONE = 65536;

/** Engine constants the server fixes and ships (Math.exp may round differently between JS engines). */
export interface Fixed {
  /** Q20 weight per synapse code */
  w20: Int32Array;
  /** exp(-dt/tau) in Q16 */
  decay: number;
  /** noise probability per neuron per step, out of 2^32 */
  noiseThresh: number;
  /** noise kick, Q16 */
  noiseAmp: number;
}

export function fixedFrom(lut: Float32Array, p: { dt: number; tau: number; noise_hz: number; noise_amp: number }): Fixed {
  return {
    w20: Int32Array.from(lut, (w) => Math.round(w * 2 ** 20)),
    decay: Math.round(Math.exp(-p.dt / p.tau) * 65536),
    noiseThresh: Math.min(2 ** 32 - 1, Math.round(p.noise_hz * p.dt * 2 ** 32)),
    noiseAmp: Math.round(p.noise_amp * 65536),
  };
}

/** A job's own numbers in fixed point. Multiplying by a power of two and rounding is exact everywhere. */
export function jobFixed(t: TaskParams): { gain: number; tonic: number; inject: number } {
  const gain = Math.round(t.gain * 4096);
  if (!(gain >= 0 && gain < 65536)) throw new Error(`gain ${t.gain} out of range`);
  return { gain, tonic: Math.round(t.tonic * 65536) | 0, inject: t.channel === "none" ? 0 : Math.round(t.amount * 65536) | 0 };
}

/** floor(a * b / 65536) for int32 a and 0 <= b < 65536, wrapping like WGSL (no 64-bit integers there). */
export function mulshift16(a: number, b: number): number {
  return (Math.imul(a >> 16, b) + (((a & 0xffff) * b) >>> 16)) | 0;
}

/** Chris Wellons' lowbias32 integer hash. */
export function lowbias32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Multipliers shared with the WGSL in web/gpu.ts. */
export const MIX = { noise: 0x85ebca77, spikeA: 0x9e3779b1, spikeB: 0x7feb352d } as const;

/** Per brain per step: keys the noise of every neuron. */
export const noiseKey = (seed: number, step: number): number =>
  lowbias32((Math.imul(step, 0x9e3779b1) ^ lowbias32((seed ^ 0x5bd1e995) >>> 0)) >>> 0);
/** Per step: key the two spike-record sums. */
export const spikeKeyA = (step: number): number => lowbias32((Math.imul(step, 0xc2b2ae3d) ^ 0x27d4eb2f) >>> 0);
export const spikeKeyB = (step: number): number => lowbias32((Math.imul(step, 0x165667b1) ^ 0x61c88647) >>> 0);

export const noiseDraw = (neuron: number, key: number): number => lowbias32((Math.imul(neuron, MIX.noise) ^ key) >>> 0);
export const spikeHashA = (neuron: number, key: number): number => lowbias32((Math.imul(neuron, MIX.spikeA) ^ key) >>> 0);
export const spikeHashB = (neuron: number, key: number): number => lowbias32((Math.imul(neuron, MIX.spikeB) ^ key) >>> 0);
