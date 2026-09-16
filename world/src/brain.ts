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
 * The mushroom body learns on its own rule (`learning.mb`, MEMORY below), the way the real one does:
 *   a Kenyon cell's spike leaves a presynaptic trace lasting MEMORY.preTau; when a dopamine neuron fires while that
 *   trace is up, that cell's synapse onto the MBON of the teacher's compartment is DEPRESSED. PPL1-g2a1
 *   (punishment) depresses KC -> MBON-g2a1, the output that pushes toward the odour; PAM-g5 (reward) depresses
 *   KC -> MBON-g5b2a, the one that pushes away. A punished odour therefore loses its "toward" vote and the fly turns
 *   away from it, and only that odour is affected, because only the Kenyon cells that odour drives carry a trace.
 *   A teacher only writes inside a burst (its running rate above MEMORY.burstHz): a trickle of dopamine teaches nothing.
 *   Depression only, down to MEMORY.floor of the birth size, and what is left fades with MEMORY.forgetTau. These
 *   synapses are left out of the synaptic rescaling below: rescaling would put the memory straight back.
 *   The teachers are not injected by the world. They are ordinary neurons fed by LC4 (a threat filling the eye),
 *   LgLG (a knock), DA2 PN (geosmin and CO2 -- including the alarm CO2 a frightened neighbour gives off) and LB3
 *   (juice on the labellum). Learning from another fly needs no new channel: it is that CO2 route.
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
import { MB_POPS, type Population, type Wiring } from "./wiring.ts";

interface MbMap {
  /** neuron -> Kenyon cell slot, -1 for everything else */
  slotOf: Int32Array;
  /** neuron -> 0 none, 1 punishment teacher, 2 reward teacher */
  danOf: Uint8Array;
  kcCount: number;
  punishCount: number;
  rewardCount: number;
  /** per synapse: 1 if it is a KC -> MBON synapse (the only ones the rule may touch) */
  isMb: Uint8Array;
  /** those synapses grouped by Kenyon cell: synE[synPtr[k] .. synPtr[k+1]] */
  synE: Int32Array;
  /** 0 = onto the toward-MBON (punishment depresses it), 1 = onto the away-MBON (reward does) */
  synGroup: Uint8Array;
  synPtr: Int32Array;
}

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

/** The mushroom-body rule: dopamine-gated depression of KC -> MBON, and how long what is left lasts. */
export const MEMORY = {
  preTau: 5, // seconds a Kenyon cell spike stays eligible for a teacher
  depress: 0.12, // share of the birth size removed per teacher spike, times the trace
  floor: 0.15, // a KC -> MBON synapse never drops below this share of its birth size
  forgetTau: 900, // seconds: what is left drifts back
  trace: 0.4, // how much one KC spike adds to the trace (capped at 1)
  // A teacher writes only in a burst. Without one, 3 minutes of a 0.7 Hz dopamine trickle (a crowd's stray CO2)
  // flattened memories as surely as a real fright (round 2). Set 2026-09-16 by a rule fixed before looking: twice the
  // highest rate any held fly's teacher reached with no punishment anywhere (2.5 Hz in 0.5 s windows; with a swatter
  // it bursts to 12-13 Hz).
  burstHz: 5,
  burstTau: 0.5, // seconds: the teacher's rate is averaged over about this long
};

export interface Learning { hebbian: boolean; reward: boolean; mb: boolean }

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
  /** exp(-dt / tau) per neuron, rebuilt if dt or tau change */
  private decayPer: Float32Array | null = null;
  private decayFor = 0;
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
  readonly modalityGain: Record<string, number> = { vision: 1, olfaction: 1, memory: 1, mechanosensory: 1, central: 1, descending: 1, motor: 1 };
  /** which rules run; the world hands every fly the same object so a switch applies to all */
  learning: Learning = { hebbian: false, reward: false, mb: false };
  /** this fly's learning-rate genes */
  learnScale = { hebb: 1, reward: 1, mb: 1 };
  /** causal pre -> post pairings seen, and rewards received (for the data) */
  pairings = 0;
  rewards = 0;
  /** how much depression the mushroom body has taken, summed over synapses (for the data) */
  depressed = 0;
  private kcTrace: Float32Array | null = null;
  /** each teacher's running rate, Hz per neuron: [punishment, reward] */
  private teachHz = [0, 0];
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

    const decay = this.decays(p);
    const pNoise = p.noiseHz * p.dt;
    const v = this.v;
    const drive = this.drive;
    const rand = this.rand;
    const spikes = this.count;
    spikes.fill(0);
    let m = 0;
    for (let i = 0; i < n; i++) {
      let x = decay[i] * v[i] + p.gain * cur[i] + p.tonic * tonicScale[i] * this.tonicGain + drive[i];
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
    if (this.learning.mb) this.remember(p.dt);
    if (++this.stepsDone % 50 === 0 && (this.learning.hebbian || this.learning.reward || this.learning.mb || this.pairings || this.depressed)) {
      this.recover(p.dt * 50);
    }

    const a = Math.exp(-p.dt / RATE_TAU);
    const pops = this.w.pops;
    for (let q = 0; q < pops.length; q++) {
      const hz = spikes[q] / (pops[q].count * p.dt);
      this.rate[q] = a * this.rate[q] + (1 - a) * hz;
    }
  }

  /** exp(-dt / tau) for every neuron, with the mushroom body's longer time constants (wiring.tauScale). */
  private decays(p: BrainParams): Float32Array {
    const key = p.dt / p.tau;
    if (this.decayPer && this.decayFor === key) return this.decayPer;
    const out = new Float32Array(this.w.n);
    for (let i = 0; i < this.w.n; i++) out[i] = Math.exp(-p.dt / (p.tau * this.w.tauScale[i]));
    this.decayPer = out;
    this.decayFor = key;
    return out;
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

  /**
   * The mushroom-body rule. Every Kenyon cell that fires leaves a trace; a teacher spiking while that trace is up
   * depresses the cell's synapse onto the MBON of the teacher's compartment. Nothing else in the brain changes.
   */
  private remember(dt: number): void {
    const m = Brain.mbMap(this.w);
    if (!m.kcCount) return;
    if (!this.kcTrace) this.kcTrace = new Float32Array(m.kcCount);
    const trace = this.kcTrace;
    const fade = Math.exp(-dt / MEMORY.preTau);
    let any = false;
    for (let k = 0; k < m.kcCount; k++) {
      if (trace[k] === 0) continue;
      const t = trace[k] * fade;
      trace[k] = t > 0.02 ? t : 0;
      if (trace[k]) any = true;
    }
    let punish = 0, reward = 0;
    for (let k = 0; k < this.firedCount; k++) {
      const i = this.fired[k];
      const slot = m.slotOf[i];
      if (slot >= 0) { trace[slot] = Math.min(1, trace[slot] + MEMORY.trace); any = true; }
      const d = m.danOf[i];
      if (d === 1) punish++; else if (d === 2) reward++;
    }
    // one dose per compartment: the share of that teacher's neurons that fired this step, and only inside a burst
    const dose = [punish / Math.max(1, m.punishCount), reward / Math.max(1, m.rewardCount)];
    const k = Math.min(1, dt / MEMORY.burstTau);
    for (let c = 0; c < 2; c++) {
      this.teachHz[c] += (dose[c] / dt - this.teachHz[c]) * k;
      if (this.teachHz[c] < MEMORY.burstHz) dose[c] = 0;
    }
    if (!any || (!dose[0] && !dose[1])) return;
    const rate = MEMORY.depress * this.learnScale.mb;
    for (let slot = 0; slot < m.kcCount; slot++) {
      const t = trace[slot];
      if (t === 0) continue;
      for (let q = m.synPtr[slot]; q < m.synPtr[slot + 1]; q++) {
        const d = dose[m.synGroup[q]];
        if (d <= 0) continue;
        const e = m.synE[q];
        const b = this.base[e];
        const size = Math.abs(b);
        if (size === 0) continue;
        const mag = Math.max(MEMORY.floor * size, Math.abs(this.weight[e]) - rate * d * t * size);
        this.depressed += (Math.abs(this.weight[e]) - mag) / size;
        this.weight[e] = b < 0 ? -mag : mag;
      }
    }
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
    const fm = 1 - Math.exp(-seconds / MEMORY.forgetTau);
    const isMb = Brain.mbMap(this.w).isMb;
    const w = this.weight, b = this.base, post = this.w.rowIdx;
    const now = Brain.sums(this.w.n, 0), born = Brain.sums(this.w.n, 1);
    for (let e = 0; e < w.length; e++) {
      // a memory fades on its own clock, and stays out of the scaling below:
      // rescaling a depressed synapse back to its birth total is forgetting it
      if (isMb[e]) { if (w[e] !== b[e]) w[e] += (b[e] - w[e]) * fm; continue; }
      if (w[e] !== b[e]) w[e] += (b[e] - w[e]) * f;
      now[post[e]] += Math.abs(w[e]);
      born[post[e]] += Math.abs(b[e]);
    }
    // synaptic scaling: each neuron's total input back to its birth total
    for (let e = 0; e < w.length; e++) {
      if (isMb[e]) continue;
      const i = post[e];
      if (now[i] > 0) w[e] *= born[i] / now[i];
    }
  }

  /** How deep the memory is: mean depression of the KC -> MBON synapses. 0 = untouched, 1 = flattened. */
  memoryDepth(): number {
    const [toward, away] = this.memoryByCompartment();
    return (toward + away) / 2;
  }

  /** Mean depression onto each output: [toward-MBON (punishment writes it), away-MBON (reward writes it)]. What a fly
   *  has learned is the difference: toward - away > 0 means its smells have lost pull, i.e. learned aversion. */
  memoryByCompartment(): [number, number] {
    const m = Brain.mbMap(this.w);
    const sum = [0, 0], n = [0, 0];
    for (let q = 0; q < m.synE.length; q++) {
      const e = m.synE[q];
      if (this.base[e] === 0) continue;
      sum[m.synGroup[q]] += 1 - Math.abs(this.weight[e]) / Math.abs(this.base[e]);
      n[m.synGroup[q]]++;
    }
    return [n[0] ? sum[0] / n[0] : 0, n[1] ? sum[1] / n[1] : 0];
  }

  /** Which Kenyon cells fired on the last step: the odour's signature, one entry per KC. */
  kcActive(): Float32Array {
    const m = Brain.mbMap(this.w);
    const out = new Float32Array(m.kcCount);
    for (let k = 0; k < this.firedCount; k++) {
      const slot = m.slotOf[this.fired[k]];
      if (slot >= 0) out[slot] = 1;
    }
    return out;
  }

  private static mbMaps = new WeakMap<Wiring, MbMap>();
  /** Where the mushroom body is in this wiring: which neurons are Kenyon cells and teachers, and which synapses
   *  between them the memory rule may depress. */
  private static mbMap(w: Wiring): MbMap {
    const hit = Brain.mbMaps.get(w);
    if (hit) return hit;
    const slotOf = new Int32Array(w.n).fill(-1);
    const danOf = new Uint8Array(w.n);
    const mbonOf = new Uint8Array(w.n); // 1 = toward-MBON, 2 = away-MBON
    let kcCount = 0, punishCount = 0, rewardCount = 0;
    for (const pop of w.pops) {
      for (let i = pop.start; i < pop.start + pop.count; i++) {
        if (pop.name === MB_POPS.kc) slotOf[i] = kcCount++;
        else if (pop.name === MB_POPS.punish) { danOf[i] = 1; punishCount++; }
        else if (pop.name === MB_POPS.reward) { danOf[i] = 2; rewardCount++; }
        else if (pop.name === MB_POPS.toward) mbonOf[i] = 1;
        else if (pop.name === MB_POPS.away) mbonOf[i] = 2;
      }
    }
    const isMb = new Uint8Array(w.nnz);
    const synE: number[][] = Array.from({ length: kcCount }, () => []);
    const synG: number[][] = Array.from({ length: kcCount }, () => []);
    for (let j = 0; j < w.n; j++) {
      const slot = slotOf[j];
      if (slot < 0) continue;
      for (let e = w.colPtr[j]; e < w.colPtr[j + 1]; e++) {
        const target = mbonOf[w.rowIdx[e]];
        if (!target) continue;
        isMb[e] = 1;
        synE[slot].push(e);
        synG[slot].push(target - 1);
      }
    }
    const synPtr = new Int32Array(kcCount + 1);
    for (let k = 0; k < kcCount; k++) synPtr[k + 1] = synPtr[k] + synE[k].length;
    const map: MbMap = {
      slotOf, danOf, kcCount, punishCount, rewardCount, isMb,
      synE: Int32Array.from(synE.flat()),
      synGroup: Uint8Array.from(synG.flat()),
      synPtr,
    };
    Brain.mbMaps.set(w, map);
    return map;
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
