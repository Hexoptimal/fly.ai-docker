/**
 * A probe job: play named stimuli into the integer brain (src/fixed.ts, the same engine as a screen job) on a schedule,
 * and record spike counts per time bin for whole neuron sets. This is the data brain -> words (Flybook's translator)
 * and brain -> trades (the fly market's action reader) are fitted on, produced by the network instead of one GPU.
 *
 * Output: u16 counts (little-endian: every platform a browser runs on), bins x neurons, for each record set in order (counts over 65535 saturate). The
 * neuron order of each set is fixed by the connectome files; `recordSets` gives it (scripts/pull-house.mjs writes it
 * next to the data). Deterministic: every miner returns the same bytes.
 */
import { cells, cellsWithPrefix } from "../../world/src/connectome.ts";
import { jobFixed, mulshift16, noiseDraw, noiseKey, V_ONE, type Fixed } from "./fixed.ts";
import type { Model } from "./model.ts";

/** Flytalk's wing motor neurons (flytalk.py WING_MN). */
export const WING_MN = ["DLMn a, b", "DLMn c-f", "DVMn 1a-c", "DVMn 2a, b", "DVMn 3a, b", "MNwm35", "MNwm36",
  "b1 MN", "b2 MN", "b3 MN", "hg1 MN", "hg2 MN", "hg3 MN", "hg4 MN", "i1 MN", "i2 MN",
  "iii1 MN", "iii3 MN", "ps1 MN", "tp1 MN", "tp2 MN", "tpn MN"];

export const RECORD_SETS = ["descending", "wing"] as const;
export type RecordSet = (typeof RECORD_SETS)[number];

export interface Stimulus {
  /** exact cell types (or superclasses) */
  types?: string[];
  /** cell type prefixes, e.g. "PAM" */
  prefixes?: string[];
  side?: "L" | "R";
  /** voltage added per step while on, like a screen job's amount */
  amount: number;
  /** steps [from, to) */
  from: number;
  to: number;
}

export interface ProbeParams {
  stimuli: Stimulus[];
  steps: number;
  gain: number;
  tonic: number;
  seed: number;
  record: RecordSet[];
  bin_steps: number;
}

/** The neurons of each record set, in output order. */
export function recordSets(model: Model, record: RecordSet[]): Int32Array[] {
  return record.map((set) => (set === "descending" ? cells(model.meta, ["descending_neuron"]) : cells(model.meta, WING_MN)));
}

function stimulusCells(model: Model, s: Stimulus): Int32Array {
  const parts: Int32Array[] = [];
  if (s.types?.length) parts.push(cells(model.meta, s.types, s.side));
  for (const p of s.prefixes ?? []) parts.push(cellsWithPrefix(model.meta, p, s.side));
  const all = new Set<number>();
  for (const part of parts) for (const i of part) all.add(i);
  return Int32Array.from([...all].sort((a, b) => a - b));
}

export function runProbe(model: Model, fx: Fixed, p: ProbeParams): Uint8Array {
  const { n, colPtr, rowIdx, code } = model.w;
  const { w20, decay, noiseThresh, noiseAmp } = fx;
  const { gain, tonic } = jobFixed({ channel: "none", side: "L", amount: 0, gain: p.gain, tonic: p.tonic, seed: p.seed, steps: p.steps, warm: 0 });

  // per step, the drive each neuron gets from every stimulus on at that step
  const schedule = p.stimuli.map((s) => ({ idx: stimulusCells(model, s), inject: Math.round(s.amount * 65536) | 0, from: s.from, to: s.to }));
  for (const s of schedule) if (!s.idx.length) throw new Error("a stimulus matches no neurons");
  const drive = new Int32Array(n);

  const sets = recordSets(model, p.record);
  const bins = Math.ceil(p.steps / p.bin_steps);
  const slot = new Int32Array(n).fill(-1); // neuron -> column in the output, over all sets
  let columns = 0;
  for (const set of sets) {
    set.forEach((neuron, k) => { slot[neuron] = columns + k; });
    columns += set.length;
  }
  // (a neuron in two sets is counted in the later one's column; the sets don't overlap)
  const counts = new Uint16Array(bins * columns);

  const v = new Int32Array(n);
  const cur = new Int32Array(n);
  const fired = new Int32Array(n);
  let firedCount = 0;
  for (let s = 0; s < p.steps; s++) {
    cur.fill(0);
    for (let k = 0; k < firedCount; k++) {
      const j = fired[k];
      const end = colPtr[j + 1];
      for (let e = colPtr[j]; e < end; e++) cur[rowIdx[e]] += w20[code[e]];
    }
    drive.fill(0);
    for (const st of schedule) if (s >= st.from && s < st.to) for (const i of st.idx) drive[i] = (drive[i] + st.inject) | 0;
    const key = noiseKey(p.seed, s);
    const bin = Math.floor(s / p.bin_steps);
    let m = 0;
    for (let i = 0; i < n; i++) {
      let x = (mulshift16(v[i], decay) + mulshift16(cur[i], gain) + tonic + drive[i]) | 0;
      if (noiseDraw(i, key) < noiseThresh) x = (x + noiseAmp) | 0;
      if (x >= V_ONE) {
        fired[m++] = i;
        x = 0;
        const c = slot[i];
        if (c >= 0) {
          const at = bin * columns + c;
          if (counts[at] < 65535) counts[at]++;
        }
      }
      v[i] = x;
    }
    firedCount = m;
  }
  return new Uint8Array(counts.buffer);
}
