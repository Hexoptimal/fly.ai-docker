/**
 * yespower hashing on this machine, through the very same WebAssembly the miners run (../yespower). The bridge
 * uses it to re-check every hit before sending it to the pool, so a miner can't get a bad share submitted, and the
 * test's mock pool uses it to judge shares.
 *
 * Running the program for one nonce with an all-ones target always reports that nonce as a hit, which hands back
 * its hash. It costs a few milliseconds, which only matters per share, never per nonce.
 */
import { readFileSync } from "node:fs";
import { runWasm } from "../../web/openjob.ts";

export interface Params {
  /** 0 for yespower 0.5 (the "yescrypt" pools mean this one), 1 for yespower 1.0 */
  version: 0 | 1;
  N: number;
  r: number;
  /** the coin's personalization string; "" for most, and some coins pass the header itself (see `persIsHeader`) */
  pers: string;
  /** Globalboost-Y and friends: the personalization string is the 80-byte header being hashed */
  persIsHeader?: boolean;
}

/** Coins whose parameters are published; add more as needed. */
export const COINS: Record<string, Params> = {
  // zpool's "yescrypt" mines GlobalBoost-Y: yescrypt 0.5 keyed by the header itself (checked against BSTY block
  // 600000, whose hash only this variant reproduces). The keyless form is kept as yescryptPlain.
  yescrypt: { version: 0, N: 2048, r: 8, pers: "", persIsHeader: true },
  yescryptPlain: { version: 0, N: 2048, r: 8, pers: "" },
  yescryptR16: { version: 0, N: 4096, r: 16, pers: "" },
  yescryptR32: { version: 0, N: 4096, r: 32, pers: "" },
  yespower: { version: 1, N: 2048, r: 32, pers: "" },
  yespowerR16: { version: 1, N: 4096, r: 16, pers: "" },
  yespowerSUGAR: { version: 1, N: 2048, r: 32, pers: "Satoshi Nakamoto" },
  yespowerTIDE: { version: 1, N: 2048, r: 8, pers: "" },
  yespowerURX: { version: 1, N: 2048, r: 32, pers: "UraniumX" },
  yespowerLTNCG: { version: 1, N: 2048, r: 32, pers: "LTNCGYES" },
  yespowerMGPC: { version: 1, N: 2048, r: 32, pers: "Magpiecoin" },
  yespowerADVC: { version: 1, N: 2048, r: 32, pers: "AdventureCoin" },
  BSTY: { version: 0, N: 2048, r: 8, pers: "", persIsHeader: true },
};

export const PROGRAM = readFileSync(new URL("../yespower/yespower_search.wasm", import.meta.url));

/** The job input the program takes: a header without its nonce, a nonce range, a target and the parameters. */
export function input(prefix: Buffer, firstNonce: number, count: number, target: Buffer, p: Params, _header?: Buffer): Buffer {
  // a coin keyed by its own header: the program uses each nonce's full header (version flag 0x80), so no bytes here.
  // (Passing one fixed header was the old way, and it hashed every nonce but the first wrong.)
  const pers = p.persIsHeader ? Buffer.alloc(0) : Buffer.from(p.pers);
  if (pers.length > 255) throw new Error("the personalization string is at most 255 bytes");
  const b = Buffer.alloc(126 + pers.length);
  prefix.copy(b, 0, 0, 76);
  b.writeUInt32LE(firstNonce >>> 0, 76);
  b.writeUInt32LE(count >>> 0, 80);
  target.copy(b, 84);
  b[116] = p.version | (p.persIsHeader ? 0x80 : 0);
  b.writeUInt32LE(p.N, 117);
  b.writeUInt32LE(p.r, 121);
  b[125] = pers.length;
  pers.copy(b, 126);
  return b;
}

/** Hits from a job's output: each is a nonce and the hash the miner claims for it. */
export function hits(output: Uint8Array): { nonce: number; hash: Buffer }[] {
  const view = Buffer.from(output);
  const n = view.length >= 4 ? view.readUInt32LE(0) : 0;
  const out = [];
  for (let i = 0; i < n && 40 + i * 36 <= view.length; i++) {
    out.push({ nonce: view.readUInt32LE(4 + i * 36), hash: view.subarray(8 + i * 36, 40 + i * 36) });
  }
  return out;
}

const ALL_ONES = Buffer.alloc(32, 0xff);

/** yespower of one header (80 bytes), as the coin's PoW hash. Returns the raw 32 bytes, little-endian as mined. */
export async function yespowerHash(header: Buffer, p: Params): Promise<Buffer> {
  const nonce = header.readUInt32LE(76);
  const job = input(header, nonce, 1, ALL_ONES, p, header);
  const { output } = await runWasm(new Uint8Array(PROGRAM), new Uint8Array(job), new Uint8Array(32), 4096);
  const found = hits(output);
  if (!found.length) throw new Error("the hasher found nothing with an all-ones target, which can't happen");
  return found[0].hash;
}

/** The hash as a number for comparing with a target: the coins read it little-endian, so display order is reversed. */
export const display = (hash: Buffer): Buffer => Buffer.from(hash).reverse();
