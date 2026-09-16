/**
 * What a fly is born with, and what it passes on.
 *
 * Brain genes scale the wiring before normalisation (one multiplier per connection block in EDGES), the resting
 * drive of each population (tonic) and how strongly each sense injects (receptor gain per modality). Learning genes
 * scale the two plasticity rules in brain.ts. Body genes set lifespan, flight power and clutch size.
 *
 * Founders draw every gene around 1 (or the old fixed value). A baby takes each gene from its mother or its father
 * at random (one coin per gene) and then mutates it a little, so variation survives the generations instead of
 * blending away. Nothing here selects anything: who lives and who breeds is whatever happens in the world.
 *
 * One known limit (world/README "What isn't real"): every neuron's incoming weights are normalised to sum to 1, so
 * an edge gene only changes a neuron if that neuron has inputs from other blocks too. Tonic and receptor genes are
 * not normalised away.
 */
import { EDGES, POPULATIONS, type Modality } from "./wiring.ts";

export const SENSES: Modality[] = ["vision", "olfaction", "mechanosensory"];

export const GENES = {
  founderSd: { edge: 0.12, tonic: 0.04, sense: 0.08, learn: 0.25, lifespan: 60, flight: 0.04, clutch: 1.5 },
  mutationSd: { edge: 0.04, tonic: 0.015, sense: 0.03, learn: 0.08, lifespan: 20, flight: 0.015, clutch: 0.6 },
  range: {
    edge: [0.3, 3], tonic: [0.7, 1.3], sense: [0.5, 1.6], learn: [0, 3],
    lifespan: [400, 900], flight: [0.88, 1.12], clutch: [4, 16],
  } as Record<string, [number, number]>,
};

export interface Genome {
  /** strength multiplier per connection block, aligned with EDGES */
  edge: Float32Array;
  /** resting-drive multiplier per population spec, aligned with POPULATIONS */
  tonic: Float32Array;
  sense: Record<string, number>;
  learn: { hebb: number; reward: number; mb: number };
  lifespan: number;
  flight: number;
  clutch: number;
}

const clamp = (x: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, x));

function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

export function founder(rand: () => number): Genome {
  const { founderSd: sd, range } = GENES;
  return {
    edge: Float32Array.from(EDGES, () => clamp(1 + sd.edge * gauss(rand), range.edge)),
    tonic: Float32Array.from(POPULATIONS, () => clamp(1 + sd.tonic * gauss(rand), range.tonic)),
    sense: Object.fromEntries(SENSES.map((s) => [s, clamp(1 + sd.sense * gauss(rand), range.sense)])),
    learn: {
      hebb: clamp(1 + sd.learn * gauss(rand), range.learn),
      reward: clamp(1 + sd.learn * gauss(rand), range.learn),
      mb: clamp(1 + sd.learn * gauss(rand), range.learn),
    },
    lifespan: clamp(650 + sd.lifespan * gauss(rand), range.lifespan),
    flight: clamp(1 + sd.flight * gauss(rand), range.flight),
    clutch: clamp(10 + sd.clutch * gauss(rand), range.clutch),
  };
}

/** One coin per gene for which parent it comes from, then a small mutation. */
export function child(mother: Genome, father: Genome, rand: () => number): Genome {
  const { mutationSd: sd, range } = GENES;
  const pick = (m: number, f: number, s: number, r: [number, number]) => clamp((rand() < 0.5 ? m : f) + s * gauss(rand), r);
  return {
    edge: Float32Array.from(mother.edge, (m, i) => pick(m, father.edge[i] ?? m, sd.edge, range.edge)),
    tonic: Float32Array.from(mother.tonic, (m, i) => pick(m, father.tonic[i] ?? m, sd.tonic, range.tonic)),
    sense: Object.fromEntries(SENSES.map((s) => [s, pick(mother.sense[s], father.sense[s], sd.sense, range.sense)])),
    learn: {
      hebb: pick(mother.learn.hebb, father.learn.hebb, sd.learn, range.learn),
      reward: pick(mother.learn.reward, father.learn.reward, sd.learn, range.learn),
      mb: pick(mother.learn.mb, father.learn.mb, sd.learn, range.learn),
    },
    lifespan: pick(mother.lifespan, father.lifespan, sd.lifespan, range.lifespan),
    flight: pick(mother.flight, father.flight, sd.flight, range.flight),
    clutch: pick(mother.clutch, father.clutch, sd.clutch, range.clutch),
  };
}

/** Connection blocks worth naming in the data: the pathways the README measures. */
export const KEY_EDGES: Record<string, [string, string]> = {
  loom_escape: ["LPLC2", "DNp01"],
  threat_escape: ["LC4", "DNp01"],
  odour_steer: ["lPN", "PFL3"],
  odour_wind: ["lPN", "WED"],
  contact_courtship: ["Gr68a", "P1"],
  aversion_turn: ["LH", "LAL"],
  taste_stop: ["LB3", "IN19A"],
  odour_to_kc: ["uPN", "KC"],
  alarm_to_teacher: ["DA2 PN", "PPL1-g2a1"],
  memory_turn: ["MBON-g2a1", "LAL"],
};

function edgeGene(g: Genome, from: string, to: string): number {
  const i = EDGES.findIndex((e) => e.from === from && e.to === to);
  return i >= 0 ? g.edge[i] : NaN;
}

/** The genes as flat named numbers, for the lineage table and the inheritance charts. */
export function summary(g: Genome): Record<string, number> {
  const out: Record<string, number> = {
    lifespan: g.lifespan, flight: g.flight, clutch: g.clutch,
    vision_gain: g.sense.vision, olfaction_gain: g.sense.olfaction, mechano_gain: g.sense.mechanosensory,
    hebb_rate: g.learn.hebb, reward_rate: g.learn.reward, memory_rate: g.learn.mb,
    edge_mean: g.edge.reduce((a, b) => a + b, 0) / Math.max(1, g.edge.length),
    motor_tonic: meanTonic(g, "motor"),
  };
  for (const [name, [from, to]] of Object.entries(KEY_EDGES)) out[`gene_${name}`] = edgeGene(g, from, to);
  return out;
}

function meanTonic(g: Genome, modality: Modality): number {
  let s = 0, n = 0;
  POPULATIONS.forEach((p, i) => { if (p.modality === modality) { s += g.tonic[i]; n++; } });
  return n ? s / n : 1;
}
