/**
 * Building and reading kHeavyHash jobs: the bytes the shader (khh.wgsl) takes, and the hits it gives back.
 * Shared by the bridge and the tests.
 */
import { generateMatrix } from "./khh.ts";

/** Nibbles per word, eight to a u32, as the shader reads them. */
export function packMatrix(matrix: Uint8Array): Uint8Array {
  const out = new Uint8Array(4096 / 2);
  for (let i = 0; i < 4096; i += 2) out[i / 2] = matrix[i] | (matrix[i + 1] << 4);
  return out;
}

export interface JobSpec {
  prePowHash: Uint8Array;
  timestamp: bigint;
  firstNonce: bigint;
  /** nonces each invocation walks; the whole job is this times 64 times the workgroups dispatched */
  perThread: number;
  /** little-endian, the order the hash is compared in */
  target: Uint8Array;
  /** the job's matrix; built from the pre-pow hash when left out */
  matrix?: Uint8Array;
}

export const INPUT_BYTES = 84 + 2048;
export const MAX_HITS = 16;
export const OUTPUT_BYTES = 4 + MAX_HITS * 40;

/** One job's input: the header parts, the nonce range and the matrix. */
export function buildInput(spec: JobSpec): Uint8Array {
  const b = new Uint8Array(INPUT_BYTES);
  const view = new DataView(b.buffer);
  b.set(spec.prePowHash, 0);
  view.setBigUint64(32, spec.timestamp, true);
  view.setBigUint64(40, spec.firstNonce, true);
  view.setUint32(48, spec.perThread, true);
  b.set(spec.target, 52);
  b.set(packMatrix(spec.matrix ?? generateMatrix(spec.prePowHash)), 84);
  return b;
}

/** The hits in a job's output: the nonces that met the target, and the hash the miner claims for each. */
export function readHits(output: Uint8Array): { nonce: bigint; hash: Uint8Array }[] {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const n = Math.min(view.getUint32(0, true), MAX_HITS);
  const hits = [];
  for (let i = 0; i < n; i++) {
    const at = 4 + i * 40;
    hits.push({ nonce: view.getBigUint64(at, true), hash: output.subarray(at + 8, at + 40) });
  }
  return hits;
}
