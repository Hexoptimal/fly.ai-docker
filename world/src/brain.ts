/**
 * Leaky integrate-and-fire, the same update as fly_brain.py:
 *
 *   v <- exp(-dt/tau) * v + gain * (W @ spikes) + tonic + noise + injected
 *   v >= 1  ->  spike, reset to 0
 *
 * One Wiring is shared by every fly (same wiring, own voltages and noise), which
 * is exactly what FlyBrain(batch=N) does in the Python.
 */
import { mulberry32 } from "./rng.ts";
import type { Population, Wiring } from "./wiring.ts";

export interface BrainParams {
  dt: number;
  tau: number;
  gain: number;
  tonic: number;
  noiseHz: number;
  noiseAmp: number;
}

export const DEFAULT_PARAMS: BrainParams = {
  dt: 0.02, // 50 steps/s, as in fly_brain.py
  tau: 0.1,
  gain: 1.5, // swept in tools/sweep.ts: descending neurons quiet at rest,
  tonic: 0.07, // looming still gets through (the Python uses 3.0 / 0.14 on 166,700 neurons)
  noiseHz: 1.2,
  noiseAmp: 0.22,
};

const RATE_TAU = 0.18; // seconds, for the displayed / decoded firing rates

export class Brain {
  readonly w: Wiring;
  readonly v: Float32Array;
  readonly drive: Float32Array; // injected voltage for the next step only
  readonly fired: Int32Array;
  firedCount = 0;
  /** smoothed firing rate, Hz per neuron, one entry per population */
  readonly rate: Float32Array;
  private readonly count: Float32Array;
  private rand: () => number;
  /** ageing scales these down: an old fly's receptors inject less and its
   *  motor populations rest lower, so it is visibly a worse flier */
  senseGain = 1;
  tonicGain = 1;
  private static current: Float32Array | null = null;

  constructor(wiring: Wiring, seed: number) {
    this.w = wiring;
    this.v = new Float32Array(wiring.n);
    this.drive = new Float32Array(wiring.n);
    this.fired = new Int32Array(wiring.n);
    this.rate = new Float32Array(wiring.pops.length);
    this.count = new Float32Array(wiring.pops.length);
    this.rand = mulberry32(seed);
    if (!Brain.current || Brain.current.length < wiring.n) Brain.current = new Float32Array(wiring.n);
  }

  /** Add voltage to every neuron of one population before the next step
   *  (the equivalent of FlyBrain.stimulate on brain.cells([type], side)). */
  stimulate(pop: Population, amount: number): void {
    if (amount <= 0) return;
    const end = pop.start + pop.count;
    const a = amount * this.senseGain;
    for (let i = pop.start; i < end; i++) this.drive[i] += a;
  }

  /** Per-neuron drive, used for the photoreceptor route (one value per cell). */
  stimulateAt(i: number, amount: number): void {
    this.drive[i] += amount * this.senseGain;
  }

  step(p: BrainParams): void {
    const { n, colPtr, rowIdx, weight, popOf, tonicScale } = this.w;
    const cur = Brain.current!;
    cur.fill(0, 0, n);

    // W @ spikes, scattering the outgoing column of every neuron that fired
    for (let k = 0; k < this.firedCount; k++) {
      const j = this.fired[k];
      const end = colPtr[j + 1];
      for (let e = colPtr[j]; e < end; e++) cur[rowIdx[e]] += weight[e];
    }

    const decay = Math.exp(-p.dt / p.tau);
    const pNoise = p.noiseHz * p.dt;
    const v = this.v;
    const drive = this.drive;
    const rand = this.rand;
    const spikes = this.count;
    spikes.fill(0);
    let m = 0;
    for (let i = 0; i < n; i++) {
      let x = decay * v[i] + p.gain * cur[i] + p.tonic * tonicScale[i] * this.tonicGain + drive[i];
      if (rand() < pNoise) x += p.noiseAmp;
      if (x >= 1) {
        this.fired[m++] = i;
        spikes[popOf[i]] += 1;
        x = 0;
      }
      v[i] = x;
      drive[i] = 0;
    }
    this.firedCount = m;

    const a = Math.exp(-p.dt / RATE_TAU);
    const pops = this.w.pops;
    for (let q = 0; q < pops.length; q++) {
      const hz = spikes[q] / (pops[q].count * p.dt);
      this.rate[q] = a * this.rate[q] + (1 - a) * hz;
    }
  }

  rateOf(popIndex: number): number {
    return this.rate[popIndex];
  }
}
