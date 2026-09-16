/**
 * Quick checks that mining jobs are safe to verify: the integer engine repeats exactly, changes with the
 * seed and the drive, and gives the same answer from the constants the server ships. `npm run check`
 * (src/validate.ts is the slower check that it's still the same brain as the world's.)
 */
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { fixedFrom, lowbias32, mulshift16 } from "./fixed.ts";
import { checksumAddress, personalMessageHash, recoverAddress } from "./wallet.ts";
import { loadModel } from "./load.ts";
import { runTask, type TaskParams } from "./runner.ts";

const dir = process.env.CONNECTOME_DIR ?? fileURLToPath(new URL("../../world/public/connectome/", import.meta.url));
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

// the integer helpers against exact 64-bit arithmetic
let exact = true;
for (let k = 0; k < 20000; k++) {
  const a = (Math.random() * 2 ** 32) | 0;
  const b = Math.floor(Math.random() * 65536);
  const want = Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
  if (mulshift16(a, b) !== want) exact = false;
}
check("mulshift16 is floor(a*b/65536)", exact);
check("lowbias32 reference value", lowbias32(0x12345678) === lowbias32(0x12345678) && lowbias32(1) !== lowbias32(2) && lowbias32(0) === 0);

// wallet sign-in: EIP-55 spec vectors, the well-known hashMessage("hello world"), and recovery from a
// wallet-style r || s || v signature
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const eip55 = ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"];
check("EIP-55 checksums", eip55.every((a) => checksumAddress(a.toLowerCase()) === a));
check("personal_sign hash of \"hello world\"",
  hexOf(personalMessageHash("hello world")) === "d9eba16ed0ecae432b71fe008c98cc872bb4cc214d3220a36f365326cf807d68");
const sk = secp256k1.utils.randomSecretKey();
const signer = checksumAddress(`0x${hexOf(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1))).slice(-40)}`);
const raw = secp256k1.sign(personalMessageHash("link me"), sk, { prehash: false, format: "recovered" });
const walletSig = `0x${hexOf(raw.subarray(1))}${(raw[0] + 27).toString(16)}`;
check("recovers the signer", recoverAddress("link me", walletSig) === signer);
check("a different message recovers someone else", recoverAddress("link you", walletSig) !== signer);

const t0 = performance.now();
const model = loadModel(dir);
const fx = fixedFrom(model.w.lut, model.meta.params);
console.log(`loaded ${model.w.n} neurons, ${model.w.nnz} synapses in ${Math.round(performance.now() - t0)} ms`);

const job: TaskParams = { channel: "LPLC2", side: "L", amount: 0.4, gain: 3, tonic: 0.14, seed: 7, steps: 150, warm: 50 };
const t1 = performance.now();
const a = runTask(model, fx, job);
const ms = performance.now() - t1;
check("brain is active", a.spikes > 0, `${a.spikes} spikes, ${(a.spikes / model.w.n / (job.steps * 0.02)).toFixed(2)} Hz`);
check("motor neurons fire during the drive", a.stim.reduce((x, y) => x + y, 0) > 0);
const b = runTask(model, fx, job);
check("same job, same result", JSON.stringify(a) === JSON.stringify(b), a.hash);
check("other seed, other hash", runTask(model, fx, { ...job, seed: 8 }).hash !== a.hash);
check("other drive, other hash", runTask(model, fx, { ...job, amount: 0.2 }).hash !== a.hash);

// what a miner does: rebuild the constants from what the server sends
const shipped = { ...fx, w20: new Int32Array(Array.from(fx.w20)) };
check("shipped constants reproduce", runTask(model, shipped, job).hash === a.hash);

console.log(`${(ms / job.steps).toFixed(1)} ms per step`);
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
