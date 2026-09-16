/**
 * The connectome as a mining workload: the same files and parsing as the world (world/src/connectome.ts),
 * plus the sensory inputs and motor readouts a job uses. The arithmetic jobs run is in src/fixed.ts.
 */
import { cells, cellsWithPrefix, parseMeta, parseWeights, type ConnectomeMeta, type ConnectomeWeights } from "../../world/src/connectome.ts";

/** Sensory channels a job can drive, as in world/src/connectome.worker.ts. */
export const CHANNELS = ["LPLC2", "LC4", "LPLC1", "LC10a", "SNta"] as const;
export type Channel = (typeof CHANNELS)[number];

const WING_POWER = ["DLMn a, b", "DLMn c-f", "DVMn 1a-c", "DVMn 2a, b", "DVMn 3a, b"];
const LEG_EXTEND = ["Ti extensor MN", "Tr extensor MN", "Sternotrochanter MN"];
const LEG_FLEX = ["Ti flexor MN", "Acc. ti flexor MN", "Tr flexor MN", "Acc. tr flexor MN"];

/** Motor readouts, the same groups as world/src/connectome.worker.ts. */
function outputGroups(meta: ConnectomeMeta): [string, Int32Array][] {
  const out: [string, Int32Array][] = [];
  for (const side of ["L", "R"] as const) {
    for (const dn of ["DNg100", "DNa02", "DNp01", "MDN"]) out.push([`${dn} ${side}`, cells(meta, [dn], side)]);
    out.push([`wing power ${side}`, cells(meta, WING_POWER, side)]);
    out.push([`leg extend ${side}`, cells(meta, LEG_EXTEND, side)]);
    out.push([`leg flex ${side}`, cells(meta, LEG_FLEX, side)]);
    out.push([`arm pull ${side}`, cells(meta, ["DNp02", "DNp03", "DNp04", "DNp11", "DNg40"], side)]);
    out.push([`leg kick ${side}`, cells(meta, ["DNge104", "DNge122", "DNg20", "DNge102"], side)]);
    out.push([`head tug ${side}`, cells(meta, ["DNa05", "DNa07", "DNg111", "DNae002"], side)]);
  }
  return out;
}

export interface Model {
  meta: ConnectomeMeta;
  w: ConnectomeWeights;
  /** "LPLC2_L" -> neuron indices */
  inputs: Map<string, Int32Array>;
  outputs: string[];
  outputSizes: number[];
  /** output group per neuron, -1 if none */
  groupOf: Int16Array;
}

/** Buffers are already decompressed. */
export function buildModel(metaBuf: ArrayBuffer, weightsBuf: ArrayBuffer): Model {
  const meta = parseMeta(metaBuf);
  const w = parseWeights(weightsBuf);
  const inputs = new Map<string, Int32Array>();
  for (const side of ["L", "R"] as const) {
    for (const ch of CHANNELS) {
      inputs.set(`${ch}_${side}`, ch === "SNta" ? cellsWithPrefix(meta, "SNta", side) : cells(meta, [ch], side));
    }
  }
  const groups = outputGroups(meta);
  const groupOf = new Int16Array(meta.n).fill(-1);
  groups.forEach(([, idx], g) => { for (const i of idx) groupOf[i] = g; });
  return { meta, w, inputs, outputs: groups.map(([name]) => name), outputSizes: groups.map(([, idx]) => idx.length), groupOf };
}
