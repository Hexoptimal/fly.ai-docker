/**
 * Random matrix pairs for matmul.wgsl, and the settings to order them with.
 *
 *   node examples/matmul-wgsl/make-inputs.ts --n 256 --jobs 20 --out inputs/
 *   node examples/order.ts create --program examples/matmul-wgsl/matmul.wgsl --inputs inputs/ --wallet 0x... \
 *        --dispatch 16,16,1 --output-bytes 262144 --tolerance 0.01
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

/** A and B, n x n each, deterministic from the job number. */
export function pair(n: number, job: number): Float32Array {
  let s = (job + 1) * 2654435761 >>> 0;
  const m = new Float32Array(2 * n * n);
  for (let i = 0; i < m.length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    m[i] = (s % 2000) / 1000 - 1;
  }
  return m;
}

if (process.argv[1]?.endsWith("make-inputs.ts")) {
  const n = Number(flag("n", "256"));
  const jobs = Number(flag("jobs", "20"));
  const out = flag("out", "inputs");
  mkdirSync(out, { recursive: true });
  for (let j = 0; j < jobs; j++) writeFileSync(join(out, `${String(j).padStart(6, "0")}.bin`), Buffer.from(pair(n, j).buffer));
  const groups = Math.ceil(n / 16);
  console.log(`${jobs} inputs in ${out}/ · order with --dispatch ${groups},${groups},1 --output-bytes ${4 * n * n} --tolerance 0.01`);
}
