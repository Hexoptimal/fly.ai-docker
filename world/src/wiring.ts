/**
 * The wiring diagram: populations named after real MaleCNS cell types, and the
 * connections between them. This is NOT the connectome -- it is a small
 * hand-written block structure, sparsified with a seeded PRNG, that mirrors the
 * architecture the rest of this repository runs on the real one:
 *
 *   sensory (optic lobe, antennal lobe, Johnston's organ, leg bristles)
 *     -> central brain -> descending neurons -> VNC premotor -> motor neurons
 *
 * Cell-type names and the relative sizes of the sensory classes follow the real
 * MaleCNS annotation (ol_sensory 6,098 / cb_sensory 4,868 / vnc_sensory 6,370 /
 * vnc_motor 708), scaled down by about 30x.
 *
 * Weight recipe copied from build_brain.py:
 *   weight = synapse count, negative when the PREsynaptic neuron is inhibitory
 *   (GABA / glutamate / histamine), then every neuron's incoming weights are
 *   scaled so their absolute values sum to 1.
 */
import { mulberry32 } from "./rng.ts";

export type Modality = "vision" | "olfaction" | "mechanosensory" | "central" | "descending" | "motor";

export interface PopSpec {
  name: string;
  count: number;
  inhibitory: boolean;
  modality: Modality;
  note: string;
  /** resting drive relative to the global tonic. Flight motor neurons and their
   *  premotor interneurons are tonically active in a real fly -- the flight
   *  central pattern generator runs on its own and the descending neurons
   *  modulate it -- so they rest above 1. */
  tonic?: number;
}

/** Counts are per side; both L and R are built. */
export const POPULATIONS: PopSpec[] = [
  // --- optic lobe (ol_sensory: 6,098 photoreceptors in the real brain) -------
  { name: "R1-6", count: 12, inhibitory: true, modality: "vision", note: "photoreceptors (histamine, inhibitory)" },
  { name: "L1/L2", count: 10, inhibitory: false, modality: "vision", note: "lamina relay" },
  { name: "LPLC2", count: 10, inhibitory: false, modality: "vision", note: "looming" },
  { name: "LC4", count: 8, inhibitory: false, modality: "vision", note: "fast looming / threat" },
  { name: "LPLC1", count: 8, inhibitory: false, modality: "vision", note: "small approaching objects" },
  { name: "LC10a", count: 10, inhibitory: false, modality: "vision", note: "target tracking, close approach" },
  { name: "VS", count: 5, inhibitory: false, modality: "vision", note: "lobula plate VS: ventral optic flow (height)" },

  // --- antennal lobe (cb_sensory: ORNs named by their glomerulus) ------------
  { name: "ORN_DM1", count: 6, inhibitory: false, modality: "olfaction", note: "ORN DM1: ethyl acetate, ripe fruit" },
  { name: "ORN_VM5d", count: 6, inhibitory: false, modality: "olfaction", note: "ORN VM5d: ethyl butyrate, fermenting fruit" },
  { name: "ORN_VL2a", count: 6, inhibitory: false, modality: "olfaction", note: "ORN VL2a: acetic acid, vinegar" },
  { name: "IR92a", count: 5, inhibitory: false, modality: "olfaction", note: "IR92a: ammonia and amines, carrion and dung" },
  { name: "ORN_DA1", count: 5, inhibitory: false, modality: "olfaction", note: "ORN DA1: cVA, the fly pheromone" },
  { name: "ORN_VA1d", count: 5, inhibitory: false, modality: "olfaction", note: "ORN VA1d: cVA, the fly pheromone" },
  { name: "Or56a", count: 5, inhibitory: false, modality: "olfaction", note: "Or56a -> DA2: geosmin, harmful microbes. Aversive." },
  { name: "Gr21a", count: 4, inhibitory: false, modality: "olfaction", note: "Gr21a/Gr63a -> V: CO2. Aversive." },
  { name: "Gr68a", count: 4, inhibitory: false, modality: "olfaction", note: "Gr68a/ppk23: foreleg contact chemoreceptors, female pheromone" },
  { name: "AL-LN", count: 8, inhibitory: true, modality: "olfaction", note: "antennal lobe local neurons (GABA)" },
  { name: "lPN", count: 14, inhibitory: false, modality: "olfaction", note: "projection neurons, AL -> protocerebrum" },
  { name: "DA2 PN", count: 6, inhibitory: false, modality: "olfaction", note: "DA2 and V glomerulus PNs: the aversive line" },
  { name: "LH", count: 8, inhibitory: false, modality: "olfaction", note: "lateral horn: innate valence" },

  // --- mechanosensory (JO + vnc_sensory leg neurons) ------------------------
  { name: "JO", count: 10, inhibitory: false, modality: "mechanosensory", note: "Johnston's organ: wind, airspeed, wingbeat" },
  { name: "WED", count: 8, inhibitory: false, modality: "mechanosensory", note: "wedge / AMMC, the JO target" },
  { name: "SNta", count: 10, inhibitory: false, modality: "mechanosensory", note: "tarsal sensory neurons (leg contact)" },
  { name: "LgLG", count: 6, inhibitory: false, modality: "mechanosensory", note: "hair plate / campaniform (load, knocks)" },
  { name: "LB3", count: 6, inhibitory: false, modality: "mechanosensory", note: "labellar taste bristles (juice)" },

  // --- central brain --------------------------------------------------------
  { name: "PVLP", count: 18, inhibitory: false, modality: "central", note: "optic glomeruli interneurons" },
  { name: "PLP", count: 12, inhibitory: false, modality: "central", note: "posterior lateral protocerebrum" },
  { name: "LPi", count: 12, inhibitory: true, modality: "central", note: "lobula plate intrinsic (GABA)" },
  { name: "LAL", count: 14, inhibitory: false, modality: "central", note: "lateral accessory lobe, premotor" },
  { name: "PFL3", count: 10, inhibitory: false, modality: "central", note: "central complex steering" },
  { name: "P1", count: 6, inhibitory: false, modality: "central", note: "P1: the male courtship command neurons" },

  // --- descending neurons ---------------------------------------------------
  { name: "DNa02", count: 4, inhibitory: false, modality: "descending", note: "steering (ipsiversive turn)" },
  { name: "DNp01", count: 2, inhibitory: false, modality: "descending", note: "giant fibre, escape take-off" },
  { name: "DNg100", count: 3, inhibitory: false, modality: "descending", note: "forward flight" },
  { name: "MDN", count: 3, inhibitory: false, modality: "descending", note: "backward walking" },
  { name: "pIP10", count: 4, inhibitory: false, modality: "descending", note: "pIP10: courtship song command" },

  // --- ventral nerve cord: premotor, then motor neurons ---------------------
  { name: "VNC-IN", count: 16, inhibitory: false, modality: "motor", note: "VNC premotor interneurons (generic)", tonic: 1.9 },
  { name: "IN19A", count: 8, inhibitory: true, modality: "motor", note: "19A hemilineage interneurons (GABA)" },
  { name: "DLM MN", count: 4, inhibitory: false, modality: "motor", note: "dorsal longitudinal muscle: wing power", tonic: 2.6 },
  { name: "b1 MN", count: 3, inhibitory: false, modality: "motor", note: "basalar b1: wing steering", tonic: 1.8 },
  { name: "b2 MN", count: 3, inhibitory: false, modality: "motor", note: "basalar b2: wing steering", tonic: 1.8 },
  { name: "Ti flexor MN", count: 4, inhibitory: false, modality: "motor", note: "tibia flexor", tonic: 1.2 },
  { name: "Ti extensor MN", count: 3, inhibitory: false, modality: "motor", note: "tibia extensor (jump)" },
  { name: "Tr flexor MN", count: 3, inhibitory: false, modality: "motor", note: "trochanter flexor", tonic: 1.2 },
  { name: "Sternotrochanter MN", count: 3, inhibitory: false, modality: "motor", note: "sternotrochanter: take-off" },
];

/** Food-odour receptor types and pheromone (cVA) receptor types, split the way
 *  the real glomeruli are: DM1/VM5d/VL2a answer fruit esters and vinegar, DA1
 *  and VA1d answer cVA, which flies release and which is why they aggregate. */
export const ORN_FOOD = ["ORN_DM1", "ORN_VM5d", "ORN_VL2a", "IR92a"];
export const ORN_CVA = ["ORN_DA1", "ORN_VA1d"];
export const ORN_AVERSIVE = ["Or56a", "Gr21a"];
export const ORN_TYPES = [...ORN_FOOD, ...ORN_CVA, ...ORN_AVERSIVE];

type Mode = "ipsi" | "contra" | "both";
interface Edge {
  from: string;
  to: string;
  mode: Mode;
  p: number;
  w: number;
}

const C = (from: string, to: string, mode: Mode, p: number, w = 1): Edge => ({ from, to, mode, p, w });

/** Connection blocks: p = chance a given pre-post pair exists,
 *  w = mean synapse count for that pair (before normalisation). */
export const EDGES: Edge[] = [
  // ======================= vision ==========================================
  // Photoreceptors are histaminergic, so they INHIBIT the lamina: a dark object
  // releases L1/L2. That is the real sign inversion, and it is also where the
  // repo's Python model loses the signal (sweep.py).
  C("R1-6", "L1/L2", "ipsi", 0.4, 3),
  C("L1/L2", "PVLP", "ipsi", 0.25, 2),
  C("L1/L2", "LPLC2", "ipsi", 0.16, 1.5),
  C("L1/L2", "LC4", "ipsi", 0.1, 1.5),
  C("L1/L2", "LPLC1", "ipsi", 0.14, 1.5),
  C("L1/L2", "LC10a", "ipsi", 0.14, 1.5),

  // looming -> escape; looming -> turn away (veto own side, drive the other)
  C("LPLC2", "DNp01", "ipsi", 0.55, 4),
  C("LPLC2", "PLP", "ipsi", 0.3, 2),
  C("LPLC2", "LPi", "ipsi", 0.35, 3),
  C("LPLC2", "LAL", "contra", 0.3, 2.5),
  C("LPLC2", "MDN", "ipsi", 0.35, 2),

  C("LC4", "DNp01", "ipsi", 0.7, 5),
  C("LC4", "PLP", "ipsi", 0.25, 2),
  C("LC4", "LPi", "ipsi", 0.3, 2),
  C("LC4", "LAL", "contra", 0.25, 2),

  C("LPLC1", "PVLP", "ipsi", 0.3, 2),
  C("LPLC1", "LPi", "ipsi", 0.3, 2),
  C("LPLC1", "MDN", "ipsi", 0.25, 1.5),

  // close-range approach: the fruit the fly is nearly on top of
  C("LC10a", "PVLP", "ipsi", 0.3, 2),
  C("LC10a", "PFL3", "ipsi", 0.4, 3),
  C("LC10a", "LAL", "ipsi", 0.35, 3),

  // ======================= olfaction =======================================
  // ORNs -> their glomerulus: projection neurons out, local neurons for gain
  // control and left-right contrast.
  ...[...ORN_FOOD, ...ORN_CVA].flatMap((orn) => [
    C(orn, "lPN", "ipsi", 0.45, 3),
    C(orn, "AL-LN", "ipsi", 0.32, 2),
  ]),
  // the aversive line: geosmin and CO2 have their own glomeruli and their own
  // projection neurons, and they reach steering with the opposite sign
  ...ORN_AVERSIVE.flatMap((orn) => [
    C(orn, "DA2 PN", "ipsi", 0.55, 4),
    C(orn, "AL-LN", "ipsi", 0.25, 2),
  ]),
  // courtship: foreleg contact with a female and the visual target drive P1;
  // cVA (from males, and from a female a male has already mated) reaches the
  // GABAergic local neurons, which suppress it. No coin flip anywhere.
  C("Gr68a", "P1", "ipsi", 0.6, 4),
  C("LC10a", "P1", "ipsi", 0.35, 2.5),
  C("AL-LN", "P1", "ipsi", 0.4, 3),
  C("P1", "pIP10", "ipsi", 0.6, 4),
  C("P1", "LAL", "ipsi", 0.3, 2), // follow her
  C("pIP10", "b1 MN", "ipsi", 0.5, 3), // song is a wing motor pattern
  C("pIP10", "b2 MN", "ipsi", 0.4, 3),
  C("pIP10", "VNC-IN", "ipsi", 0.3, 2),

  C("DA2 PN", "LH", "ipsi", 0.5, 3.5),
  C("LH", "LPi", "ipsi", 0.45, 3), // veto steering toward the bad side
  C("LH", "LAL", "contra", 0.4, 3), // and drive the other side: turn away
  C("LH", "MDN", "ipsi", 0.3, 2), // back off
  // ventral optic flow: too much flow means too low, so push the wings harder
  C("VS", "DNg100", "ipsi", 0.4, 3),
  C("VS", "PVLP", "ipsi", 0.2, 1.5),
  C("AL-LN", "lPN", "ipsi", 0.3, 2.5),
  C("AL-LN", "lPN", "contra", 0.28, 2.5),
  // the plume reaches steering and thrust on the side it is stronger
  C("lPN", "PFL3", "ipsi", 0.5, 3.5),
  C("lPN", "LAL", "ipsi", 0.4, 3),
  C("lPN", "PVLP", "ipsi", 0.32, 2.5),
  C("lPN", "WED", "ipsi", 0.3, 2.5), // odour raises the gain of the wind pathway: surge upwind

  // ======================= mechanosensory ==================================
  C("JO", "WED", "ipsi", 0.5, 3),
  C("WED", "LAL", "ipsi", 0.32, 2.5), // upwind turning
  C("WED", "PVLP", "ipsi", 0.2, 1.5),
  C("WED", "DNg100", "ipsi", 0.3, 2), // airflow keeps the wings going

  C("SNta", "IN19A", "ipsi", 0.3, 2.5), // legs touching something: less flight
  C("SNta", "VNC-IN", "ipsi", 0.2, 1.5),
  C("LgLG", "IN19A", "ipsi", 0.35, 2.5),
  C("LgLG", "LPi", "ipsi", 0.22, 2), // a knock on one side vetoes that side
  C("LB3", "IN19A", "ipsi", 0.6, 4.5), // juice on the labellum: stop and feed

  // ======================= central =========================================
  C("PVLP", "PLP", "ipsi", 0.15, 1.5),
  C("PVLP", "LAL", "ipsi", 0.2, 2),
  C("PVLP", "DNg100", "ipsi", 0.4, 3),
  C("PVLP", "PVLP", "ipsi", 0.06, 1),

  C("PLP", "LAL", "contra", 0.2, 2),
  C("PLP", "DNg100", "ipsi", 0.15, 1.5),
  C("PLP", "PVLP", "ipsi", 0.08, 1),

  C("PFL3", "LAL", "ipsi", 0.35, 2.5),
  C("PFL3", "DNa02", "ipsi", 0.55, 4),

  C("LAL", "DNa02", "ipsi", 0.5, 4),
  C("LAL", "DNg100", "ipsi", 0.25, 2),
  C("LAL", "LAL", "contra", 0.08, 1),
  C("LAL", "LAL", "ipsi", 0.05, 1),

  C("LPi", "DNa02", "ipsi", 0.5, 3),
  C("LPi", "DNg100", "ipsi", 0.3, 2),
  C("LPi", "LAL", "ipsi", 0.25, 2),
  C("LPi", "PFL3", "ipsi", 0.2, 2),

  C("DNp01", "LAL", "ipsi", 0.15, 1),

  // ======================= the VNC =========================================
  // descending neurons -> premotor interneurons -> motor neurons
  C("DNg100", "VNC-IN", "ipsi", 0.5, 4),
  C("DNa02", "VNC-IN", "ipsi", 0.45, 3),
  C("DNp01", "VNC-IN", "ipsi", 0.4, 3),
  C("MDN", "VNC-IN", "ipsi", 0.4, 3),

  C("VNC-IN", "DLM MN", "ipsi", 0.55, 4),
  C("VNC-IN", "b1 MN", "ipsi", 0.45, 3),
  C("VNC-IN", "b2 MN", "ipsi", 0.4, 3),
  C("VNC-IN", "Ti flexor MN", "ipsi", 0.3, 2),
  C("VNC-IN", "Tr flexor MN", "ipsi", 0.3, 2),
  C("VNC-IN", "Ti extensor MN", "ipsi", 0.25, 2),

  // the few direct descending -> motor connections real flies also have
  C("DNa02", "b1 MN", "ipsi", 0.5, 4),
  C("DNa02", "b2 MN", "ipsi", 0.35, 2.5),
  C("DNp01", "Ti extensor MN", "ipsi", 0.7, 5), // the giant fibre jump
  C("DNp01", "Sternotrochanter MN", "ipsi", 0.7, 5),
  C("MDN", "Ti flexor MN", "ipsi", 0.4, 3),
  C("MDN", "Tr flexor MN", "ipsi", 0.4, 3),

  // 19A is GABAergic: leg contact and juice shut the wing muscles down
  C("IN19A", "DLM MN", "ipsi", 0.6, 4),
  C("IN19A", "b1 MN", "ipsi", 0.4, 3),
  C("IN19A", "VNC-IN", "ipsi", 0.22, 2),
];

export interface Population {
  name: string;
  side: "L" | "R";
  start: number;
  count: number;
  inhibitory: boolean;
  modality: Modality;
  note: string;
  /** anchor for the label in the brain view, 0..1 */
  labelX: number;
  labelY: number;
}

export interface Wiring {
  n: number;
  pops: Population[];
  index: Map<string, Population>;
  colPtr: Int32Array;
  rowIdx: Int32Array;
  weight: Float32Array;
  popOf: Int32Array;
  viewX: Float32Array;
  viewY: Float32Array;
  tonicScale: Float32Array;
  nnz: number;
}

const SIDES: ("L" | "R")[] = ["L", "R"];

/** Brain-view layout: three columns of modality blocks, L neurons left of the
 *  column's midline and R neurons right of it. */
const COLUMNS: Modality[][] = [
  ["vision", "olfaction"],
  ["mechanosensory", "central"],
  ["descending", "motor"],
];

function layout(pops: Population[], viewX: Float32Array, viewY: Float32Array): void {
  const colWidth = 1 / COLUMNS.length;
  COLUMNS.forEach((modalities, col) => {
    const specs = POPULATIONS.filter((s) => modalities.includes(s.modality));
    // one empty slot before each modality group, so its heading has room
    const slots: number[] = [];
    let slot = 0;
    let seen: Modality | null = null;
    for (const spec of specs) {
      if (spec.modality !== seen) { slot += 1; seen = spec.modality; }
      slots.push(slot);
      slot += 1;
    }
    const rows = slot;
    specs.forEach((spec, row) => {
      const yTop = (slots[row] + 0.10) / rows;
      const yBot = (slots[row] + 0.92) / rows;
      for (const side of SIDES) {
        const pop = pops.find((p) => p.name === spec.name && p.side === side)!;
        const perRow = Math.min(pop.count, 7);
        const lines = Math.ceil(pop.count / perRow);
        const x0 = col * colWidth + (side === "L" ? 0.012 : colWidth * 0.52);
        const w = colWidth * 0.44;
        pop.labelX = col * colWidth + colWidth * 0.5;
        pop.labelY = yTop - 0.34 / rows;
        for (let k = 0; k < pop.count; k++) {
          const i = pop.start + k;
          const line = Math.floor(k / perRow);
          const inLine = k % perRow;
          const wide = Math.min(perRow, pop.count - line * perRow);
          viewX[i] = x0 + ((inLine + 0.5) / wide) * w;
          viewY[i] = yTop + (lines === 1 ? 0.5 : line / (lines - 1)) * (yBot - yTop);
        }
      }
    });
  });
}

export function buildWiring(seed = 64): Wiring {
  const pops: Population[] = [];
  const index = new Map<string, Population>();
  let n = 0;
  for (const spec of POPULATIONS) {
    for (const side of SIDES) {
      const pop: Population = {
        name: spec.name,
        side,
        start: n,
        count: spec.count,
        inhibitory: spec.inhibitory,
        modality: spec.modality,
        note: spec.note,
        labelX: 0,
        labelY: 0,
      };
      pops.push(pop);
      index.set(spec.name + "_" + side, pop);
      n += spec.count;
    }
  }

  const rand = mulberry32(seed);
  const pre: number[] = [];
  const post: number[] = [];
  const raw: number[] = [];
  const add = (a: Population, b: Population, p: number, w: number) => {
    for (let i = a.start; i < a.start + a.count; i++) {
      for (let j = b.start; j < b.start + b.count; j++) {
        if (i === j || rand() >= p) continue;
        const syn = Math.max(1, Math.round(w * (0.5 + rand())));
        pre.push(i);
        post.push(j);
        raw.push(a.inhibitory ? -syn : syn);
      }
    }
  };
  for (const e of EDGES) {
    for (const side of SIDES) {
      const other: "L" | "R" = side === "L" ? "R" : "L";
      const a = index.get(e.from + "_" + side)!;
      if (e.mode === "ipsi" || e.mode === "both") add(a, index.get(e.to + "_" + side)!, e.p, e.w);
      if (e.mode === "contra" || e.mode === "both") add(a, index.get(e.to + "_" + other)!, e.p, e.w);
    }
  }

  // per-neuron input normalisation: the absolute incoming weights sum to 1
  const incoming = new Float32Array(n);
  for (let k = 0; k < raw.length; k++) incoming[post[k]] += Math.abs(raw[k]);
  const norm = new Float32Array(raw.length);
  for (let k = 0; k < raw.length; k++) norm[k] = raw[k] / Math.max(incoming[post[k]], 1e-6);

  // CSC by presynaptic neuron: one spike scatters one contiguous run
  const colPtr = new Int32Array(n + 1);
  for (const j of pre) colPtr[j + 1]++;
  for (let i = 0; i < n; i++) colPtr[i + 1] += colPtr[i];
  const cursor = colPtr.slice(0, n);
  const rowIdx = new Int32Array(raw.length);
  const weight = new Float32Array(raw.length);
  for (let k = 0; k < raw.length; k++) {
    const at = cursor[pre[k]]++;
    rowIdx[at] = post[k];
    weight[at] = norm[k];
  }

  const popOf = new Int32Array(n);
  const tonicScale = new Float32Array(n);
  pops.forEach((pop, pi) => {
    const spec = POPULATIONS.find((s) => s.name === pop.name)!;
    for (let k = 0; k < pop.count; k++) {
      popOf[pop.start + k] = pi;
      tonicScale[pop.start + k] = spec.tonic ?? 1;
    }
  });
  const viewX = new Float32Array(n);
  const viewY = new Float32Array(n);
  layout(pops, viewX, viewY);

  return { n, pops, index, colPtr, rowIdx, weight, popOf, viewX, viewY, tonicScale, nnz: raw.length };
}
