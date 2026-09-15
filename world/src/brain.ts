/**
 * Leaky integrate-and-fire, the same update as flybrain/brain.py:
 *
 *   v <- exp(-dt/tau) * v + gain * (W @ spikes) + tonic + noise + injected
 *   v >= 1  ->  spike, reset to 0
 *
 * Every fly shares the wiring's structure (which neuron connects to which) but has its own synapse strengths,
 * made from its genes (genome.ts, wiring.weightsFor), and its own voltages and noise.
 *
 * Rewiring during life (off unless the world switches it on; both rules can run together):
 *   hebbian  a synapse whose presynaptic neuron fired on the step before its postsynaptic neuron fired (a causal
 *            pairing) grows by PLASTICITY.hebbRate of its starting size
 *   reward   each causal pairing also leaves an eligibility trace that fades with PLASTICITY.eligibilityTau; when
 *            the world calls reward(r) (a meal +1; a knock or a spider strike nearby -), every traced synapse
 *            changes by rewardRate x r x trace x its starting size
 * Either way a synapse keeps its sign, stays between minScale and maxScale times its starting size, and drifts back
 * toward it with recoverTau. Once a second every neuron's incoming synapses are rescaled so their total size equals
 * what that neuron was born with (the wiring's own normalisation, flybrain/build.py): learning can move strength
 * between a neuron's inputs, not inflate the whole brain.
 *
 * Only synapses onto central-brain and descending neurons can change. Sensory inputs, the VNC premotor pool and the
 * motor neurons stay hardwired: the flight rhythm there runs on tonic drive, like a real fly's flight pattern
 * generator, and flies learn in the brain, not in the nerve cord. Why, measured on 36 flies, seed 7, 900 s
 * (2026-09-15): v1 (every synapse, no scaling) ran away to a mean change of 70% with the forward-flight inputs pinned
 * at the cap, and 40 of 46 flies starved; v2 (every synapse, with scaling) still changed 12-25% and the population
 * died out, while the same world with frozen brains ended with 10 adults and 3 generations.
 * drift() measures how far the brain has moved.
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
  dt: 0.02, // 50 steps/s, as in flybrain/brain.py
  tau: 0.1,
  gain: 1.5, // swept in tools/sweep.ts: descending neurons quiet at rest,
  tonic: 0.07, // looming still gets through (the Python uses 3.0 / 0.14 on 166,700 neurons)
  noiseHz: 1.2,
  noiseAmp: 0.22,
};

export const PLASTICITY = {
  hebbRate: 0.002,
  rewardRate: 0.04,
  eligibilityTau: 1.0,
  minScale: 0.2,
  maxScale: 3.0,
  recoverTau: 400,
};

export interface Learning { hebbian: boolean; reward: boolean }

const RATE_TAU = 0.18; // seconds, for the displayed / decoded firing rates

export class Brain {
  readonly w: Wiring;
  /** this fly's synapses, in wiring CSC order; they change if the fly learns */
  readonly weight: Float32Array;
  /** what it was born with */
  readonly base: Float32Array;
  /** per neuron: the wiring's resting-drive scale times this fly's tonic genes */
  readonly tonicScale: Float32Array;
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
  /** receptor gain per modality (genes) */
  readonly modalityGain: Record<string, number> = { vision: 1, olfaction: 1, mechanosensory: 1, central: 1, descending: 1, motor: 1 };
  /** which rules run; the world hands every fly the same object so a switch applies to all */
  learning: Learning = { hebbian: false, reward: false };
  /** this fly's learning-rate genes */
  learnScale = { hebb: 1, reward: 1 };
  /** causal pre -> post pairings seen, and rewards received (for the data) */
  pairings = 0;
  rewards = 0;
  private readonly prevFired: Int32Array;
  private readonly spiked: Uint8Array;
  /** per synapse: 1 if it may change (onto a central-brain or descending neuron) */
  private readonly plastic: Uint8Array;
  private elig: Float32Array | null = null;
  private active: Int32Array | null = null;
  private activeCount = 0;
  private stepsDone = 0;
  private static current: Float32Array | null = null;

  constructor(wiring: Wiring, seed: number, weights?: Float32Array, tonicScale?: Float32Array) {
    this.w = wiring;
    this.weight = weights ?? wiring.weight.slice();
    this.base = this.weight.slice();
    this.tonicScale = tonicScale ?? wiring.tonicScale;
    this.v = new Float32Array(wiring.n);
    this.drive = new Float32Array(wiring.n);
    this.fired = new Int32Array(wiring.n);
    this.prevFired = new Int32Array(wiring.n);
    this.spiked = new Uint8Array(wiring.n);
    this.plastic = Brain.plasticMask(wiring);
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
    const a = amount * this.senseGain * (this.modalityGain[pop.modality] ?? 1);
    for (let i = pop.start; i < end; i++) this.drive[i] += a;
  }

  /** Per-neuron drive, used for the photoreceptor route (one value per cell). */
  stimulateAt(i: number, amount: number): void {
    this.drive[i] += amount * this.senseGain * this.modalityGain.vision;
  }

  step(p: BrainParams): void {
    const { n, colPtr, rowIdx, popOf } = this.w;
    const weight = this.weight;
    const tonicScale = this.tonicScale;
    const cur = Brain.current!;
    cur.fill(0, 0, n);

    // W @ spikes, scattering the outgoing column of every neuron that fired
    const prevCount = this.firedCount;
    for (let k = 0; k < prevCount; k++) {
      const j = this.fired[k];
      this.prevFired[k] = j;
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

    if ((this.learning.hebbian || this.learning.reward) && prevCount && m) this.learn(prevCount, p.dt);
    else if (this.activeCount) this.fadeTraces(p.dt);
    if (++this.stepsDone % 50 === 0 && (this.learning.hebbian || this.learning.reward || this.pairings)) this.recover(p.dt * 50);

    const a = Math.exp(-p.dt / RATE_TAU);
    const pops = this.w.pops;
    for (let q = 0; q < pops.length; q++) {
      const hz = spikes[q] / (pops[q].count * p.dt);
      this.rate[q] = a * this.rate[q] + (1 - a) * hz;
    }
  }

  private learn(prevCount: number, dt: number): void {
    const { colPtr, rowIdx } = this.w;
    const spiked = this.spiked;
    for (let k = 0; k < this.firedCount; k++) spiked[this.fired[k]] = 1;
    const hebb = this.learning.hebbian ? PLASTICITY.hebbRate * this.learnScale.hebb : 0;
    const reward = this.learning.reward;
    if (reward && !this.elig) {
      this.elig = new Float32Array(this.w.nnz);
      this.active = new Int32Array(this.w.nnz);
    }
    this.fadeTraces(dt);
    for (let k = 0; k < prevCount; k++) {
      const j = this.prevFired[k];
      const end = colPtr[j + 1];
      for (let e = colPtr[j]; e < end; e++) {
        if (!spiked[rowIdx[e]] || !this.plastic[e]) continue;
        this.pairings++;
        if (hebb) this.nudge(e, hebb);
        if (reward) {
          if (this.elig![e] < 0.02) this.active![this.activeCount++] = e;
          this.elig![e] += 1;
        }
      }
    }
    for (let k = 0; k < this.firedCount; k++) spiked[this.fired[k]] = 0;
  }

  private fadeTraces(dt: number): void {
    if (!this.elig || !this.active) return;
    const f = Math.exp(-dt / PLASTICITY.eligibilityTau);
    let keep = 0;
    for (let k = 0; k < this.activeCount; k++) {
      const e = this.active[k];
      this.elig[e] *= f;
      if (this.elig[e] >= 0.02) this.active[keep++] = e;
      else this.elig[e] = 0;
    }
    this.activeCount = keep;
  }

  /** Move one synapse by `fraction` of its starting size (positive = stronger), within bounds, keeping its sign. */
  private nudge(e: number, fraction: number): void {
    const b = this.base[e];
    const size = Math.abs(b);
    if (size === 0) return;
    const mag = Math.max(PLASTICITY.minScale * size, Math.min(PLASTICITY.maxScale * size, Math.abs(this.weight[e]) + fraction * size));
    this.weight[e] = b < 0 ? -mag : mag;
  }

  /** The reward rule: every synapse with a trace changes by rewardRate x r x trace. */
  reward(r: number): void {
    if (!this.learning.reward || !this.elig || !this.active || r === 0) return;
    this.rewards += r;
    const k = PLASTICITY.rewardRate * this.learnScale.reward * r;
    for (let i = 0; i < this.activeCount; i++) {
      const e = this.active[i];
      this.nudge(e, k * this.elig[e]);
    }
  }

  private recover(seconds: number): void {
    const f = 1 - Math.exp(-seconds / PLASTICITY.recoverTau);
    const w = this.weight, b = this.base, post = this.w.rowIdx;
    const now = Brain.sums(this.w.n, 0), born = Brain.sums(this.w.n, 1);
    for (let e = 0; e < w.length; e++) {
      if (w[e] !== b[e]) w[e] += (b[e] - w[e]) * f;
      now[post[e]] += Math.abs(w[e]);
      born[post[e]] += Math.abs(b[e]);
    }
    // synaptic scaling: each neuron's total input back to its birth total
    for (let e = 0; e < w.length; e++) {
      const i = post[e];
      if (now[i] > 0) w[e] *= born[i] / now[i];
    }
  }

  private static masks = new WeakMap<Wiring, Uint8Array>();
  private static plasticMask(w: Wiring): Uint8Array {
    let m = Brain.masks.get(w);
    if (!m) {
      m = new Uint8Array(w.nnz);
      for (let e = 0; e < w.nnz; e++) {
        const modality = w.pops[w.popOf[w.rowIdx[e]]].modality;
        m[e] = modality === "central" || modality === "descending" ? 1 : 0;
      }
      Brain.masks.set(w, m);
    }
    return m;
  }

  private static scratch: Float32Array[] = [];
  private static sums(n: number, slot: number): Float32Array {
    let a = Brain.scratch[slot];
    if (!a || a.length < n) a = Brain.scratch[slot] = new Float32Array(n);
    a.fill(0, 0, n);
    return a;
  }

  /** Mean relative change of every synapse from what the fly was born with (0 = untouched, 0.1 = 10%). */
  drift(): number {
    const w = this.weight, b = this.base;
    let s = 0, n = 0;
    for (let e = 0; e < w.length; e++) {
      if (b[e] === 0) continue;
      s += Math.abs(w[e] - b[e]) / Math.abs(b[e]);
      n++;
    }
    return n ? s / n : 0;
  }

  /** Mean relative change per connection block (EDGES index), for export. */
  driftByEdge(blocks: number): Float32Array {
    const sum = new Float32Array(blocks), cnt = new Float32Array(blocks);
    const w = this.weight, b = this.base, of = this.w.edgeOf;
    for (let e = 0; e < w.length; e++) {
      if (b[e] === 0) continue;
      sum[of[e]] += (w[e] - b[e]) / Math.abs(b[e]);
      cnt[of[e]]++;
    }
    for (let i = 0; i < blocks; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : 0;
    return sum;
  }

  rateOf(popIndex: number): number {
    return this.rate[popIndex];
  }
}
