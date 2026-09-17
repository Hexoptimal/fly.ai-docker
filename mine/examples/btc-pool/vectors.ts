/**
 * Known Bitcoin blocks, as a pool would hand them out over Stratum, for test.ts and mock-pool.ts.
 */
import type { PoolJob } from "./stratum.ts";

/** The genesis block's coinbase transaction. */
export const GENESIS_COINBASE =
  "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000";
export const GENESIS_HEADER =
  "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
export const GENESIS_HASH = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export const GENESIS_NONCE = 2083236893;

/**
 * The genesis block as a Stratum job. Its coinbase script ("04ffff001d 0104 45 The Times ...") is cut around 12
 * bytes that stand in for extranonce1 (4 bytes) + extranonce2 (8 bytes), the way a pool splits its own coinbase.
 */
const cut = GENESIS_COINBASE.indexOf("5468652054696d6573"); // "The Times"
export const GENESIS_EXTRANONCE1 = GENESIS_COINBASE.slice(cut, cut + 8);
export const GENESIS_EXTRANONCE2 = GENESIS_COINBASE.slice(cut + 8, cut + 24);
export const GENESIS_JOB: PoolJob = {
  id: "genesis",
  prevhash: "00".repeat(32),
  coinb1: GENESIS_COINBASE.slice(0, cut),
  coinb2: GENESIS_COINBASE.slice(cut + 24),
  branch: [],
  version: "00000001",
  nbits: "1d00ffff",
  ntime: "495fab29",
};

/** Block 1: its merkle root (display order) and header fields, to pin down prevhash's byte order. */
export const BLOCK1 = {
  merkleDisplay: "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098",
  ntime: 1231469665,
  nonce: 2573394689,
  hash: "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048",
};
