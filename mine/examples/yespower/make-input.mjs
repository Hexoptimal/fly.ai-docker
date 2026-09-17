// Builds a job input for the yespower miner: node make-input.mjs [count] [out]
// Sugarchain's parameters (yespower 1.0, N=2048, r=32, pers "Satoshi Nakamoto"), a dummy header and a target of
// zero, so every nonce is tried and the run measures the full hashrate.
import { writeFileSync } from "node:fs";
const count = Number(process.argv[2] ?? 20);
const pers = Buffer.from("Satoshi Nakamoto");
const b = Buffer.alloc(126 + pers.length);
for (let i = 0; i < 76; i++) b[i] = (i * 7) & 0xff;   // header without nonce
b.writeUInt32LE(0, 76);            // first nonce
b.writeUInt32LE(count, 80);        // nonces to try
b.fill(0, 84, 116);                // target 0: nothing qualifies, so the whole range is searched
b[116] = 1;                        // yespower 1.0
b.writeUInt32LE(2048, 117);        // N
b.writeUInt32LE(32, 121);          // r
b[125] = pers.length;
pers.copy(b, 126);
writeFileSync(process.argv[3] ?? "job.bin", b);
console.log(`${b.length} bytes, ${count} nonces`);
