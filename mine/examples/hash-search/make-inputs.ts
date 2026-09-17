/**
 * Split a nonce space into job inputs for hash_search.wasm.
 *
 *   node examples/hash-search/make-inputs.ts --header <160 hex chars: an 80-byte header; its nonce is ignored>
 *        --target <64 hex, big-endian> --start 0 --total 4294967296 --per-job 2000000 --out inputs/
 *
 * Then: node examples/order.ts create --program examples/hash-search/hash_search.wasm --inputs inputs/ --wallet 0x...
 * Each output is: u32 hits, then per hit u32 nonce + 32-byte hash (display order). `order.ts watch` downloads them.
 * With no arguments it writes a 4-job demo around Bitcoin's genesis block, whose winning nonce is 2083236893.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
// Bitcoin's genesis block header and the difficulty-1 target
export const GENESIS = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
export const DIFF1 = "00000000ffff0000000000000000000000000000000000000000000000000000";

export function input(header: Buffer, start: number, count: number, target: Buffer): Buffer {
  const b = Buffer.alloc(116);
  header.copy(b, 0, 0, 76);
  b.writeUInt32LE(start >>> 0, 76);
  b.writeUInt32LE(count >>> 0, 80);
  target.copy(b, 84);
  return b;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}` || process.argv[1]?.endsWith("make-inputs.ts")) {
  const header = Buffer.from(flag("header", GENESIS), "hex");
  const target = Buffer.from(flag("target", DIFF1), "hex");
  const start = Number(flag("start", "2083000000"));
  const total = Number(flag("total", "400000"));
  const per = Number(flag("per-job", "100000"));
  const out = flag("out", "inputs");
  mkdirSync(out, { recursive: true });
  let n = 0;
  for (let at = 0; at < total; at += per, n++) {
    writeFileSync(join(out, `${String(n).padStart(6, "0")}.bin`), input(header, start + at, Math.min(per, total - at), target));
  }
  console.log(`${n} inputs in ${out}/ covering nonces ${start}..${start + total - 1}`);
}
