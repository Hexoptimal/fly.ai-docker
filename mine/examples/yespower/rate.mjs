// Hashrate of the yespower miner in the sandbox, per parameter set: node rate.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runWasm } from "../../web/openjob.ts";
const program = readFileSync(new URL("./yespower_search.wasm", import.meta.url));
const seed = createHash("sha256").update("rate").digest();
const sets = [
  { name: "yescrypt / BSTY-style", version: 0, N: 2048, r: 8, pers: "", count: 60 },
  { name: "yespower 1.0 (TIDE-style)", version: 1, N: 2048, r: 8, pers: "", count: 60 },
  { name: "yespowerR16 (Yenten-style)", version: 1, N: 4096, r: 16, pers: "Client Key", count: 20 },
  { name: "yespowerSUGAR", version: 1, N: 2048, r: 32, pers: "Satoshi Nakamoto", count: 20 },
];
for (const s of sets) {
  const pers = Buffer.from(s.pers);
  const b = Buffer.alloc(126 + pers.length);
  for (let i = 0; i < 76; i++) b[i] = (i * 7) & 0xff;
  b.writeUInt32LE(0, 76); b.writeUInt32LE(s.count, 80); b.fill(0, 84, 116);
  b[116] = s.version; b.writeUInt32LE(s.N, 117); b.writeUInt32LE(s.r, 121); b[125] = pers.length; pers.copy(b, 126);
  const t = performance.now();
  await runWasm(new Uint8Array(program), new Uint8Array(b), new Uint8Array(seed), 4096);
  const secs = (performance.now() - t) / 1000;
  const hs = s.count / secs;
  console.log(`${s.name.padEnd(28)} N=${String(s.N).padEnd(5)} r=${String(s.r).padEnd(3)} ${hs.toFixed(1)} H/s per thread (${(hs * 8).toFixed(0)} per 8-thread machine)`);
}
