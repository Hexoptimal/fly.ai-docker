/**
 * One mining job on the CPU: run the full connectome from rest in the integer brain (src/fixed.ts), drive
 * one sensory channel after a warm-up, and count motor spikes before and during the drive. web/gpu.ts runs
 * the same jobs in batches and must return exactly these results.
 *
 * `hash` sums a keyed hash of every spike of every step, so it can only be produced by running the job.
 * The counts are the research result; the hash is what gets checked.
 */
import {
  jobFixed, mulshift16, noiseDraw, noiseKey, spikeHashA, spikeHashB, spikeKeyA, spikeKeyB, V_ONE, type Fixed,
} from "./fixed.ts";
import type { Channel, Model } from "./model.ts";

export interface TaskParams {
  channel: Channel | "none";
  side: "L" | "R";
  /** voltage added to every neuron of the channel each step once the drive is on */
  amount: number;
  gain: number;
  tonic: number;
  seed: number;
  steps: number;
  /** steps before the drive starts; spikes before it count as `base`, after it as `stim` */
  warm: number;
}

export interface TaskResult {
  hash: string;
  spikes: number;
  base: number[];
  stim: number[];
}

export const hex32 = (x: number): string => (x >>> 0).toString(16).padStart(8, "0");

/** Neurons a job drives (empty for a control). */
export function drivenBy(model: Model, t: TaskParams): Int32Array {
  if (t.channel === "none" || t.amount === 0) return new Int32Array(0);
  const idx = model.inputs.get(`${t.channel}_${t.side}`);
  if (!idx) throw new Error(`no input group ${t.channel}_${t.side}`);
  return idx;
}

export function runTask(model: Model, fx: Fixed, t: TaskParams, progress?: (step: number) => void): TaskResult {
  const { n, colPtr, rowIdx, code } = model.w;
  const { w20, decay, noiseThresh, noiseAmp } = fx;
  const { gain, tonic, inject } = jobFixed(t);
  const groupOf = model.groupOf;

  const driven = new Uint8Array(n);
  for (const i of drivenBy(model, t)) driven[i] = 1;

  const v = new Int32Array(n);
  const cur = new Int32Array(n);
  const fired = new Int32Array(n);
  let firedCount = 0;
  const base: number[] = new Array(model.outputs.length).fill(0);
  const stim: number[] = new Array(model.outputs.length).fill(0);
  let h1 = 0;
  let h2 = 0;
  let spikes = 0;

  for (let s = 0; s < t.steps; s++) {
    cur.fill(0);
    for (let k = 0; k < firedCount; k++) {
      const j = fired[k];
      const end = colPtr[j + 1];
      for (let e = colPtr[j]; e < end; e++) cur[rowIdx[e]] += w20[code[e]]; // Int32Array wraps on store
    }
    const on = s >= t.warm;
    const key = noiseKey(t.seed, s);
    let m = 0;
    for (let i = 0; i < n; i++) {
      let x = (mulshift16(v[i], decay) + mulshift16(cur[i], gain) + tonic) | 0;
      if (on && driven[i]) x = (x + inject) | 0;
      if (noiseDraw(i, key) < noiseThresh) x = (x + noiseAmp) | 0;
      if (x >= V_ONE) {
        fired[m++] = i;
        x = 0;
      }
      v[i] = x;
    }
    firedCount = m;
    spikes += m;

    const counts = on ? stim : base;
    const kA = spikeKeyA(s);
    const kB = spikeKeyB(s);
    for (let k = 0; k < m; k++) {
      const j = fired[k];
      h1 = (h1 + spikeHashA(j, kA)) >>> 0;
      h2 = (h2 + spikeHashB(j, kB)) >>> 0;
      const g = groupOf[j];
      if (g >= 0) counts[g]++;
    }
    if (progress && s % 25 === 24) progress(s + 1);
  }
  return { hash: hex32(h1) + hex32(h2), spikes, base, stim };
}
