/**
 * kHeavyHash, Kaspa's proof-of-work, in TypeScript: the bridge uses it to re-check every hit before submitting a
 * share, and the tests use it to check the shader agrees.
 *
 * Ported from rusty-kaspa (consensus/pow/src/matrix.rs, crypto/hashes/src/pow_hashers.rs). One hash is:
 *   1. cSHAKE256("ProofOfWorkHash") over prePowHash || timestamp || 32 zero bytes || nonce - which is a single
 *      keccak-f1600 from a precomputed state, because the input is exactly one block
 *   2. a 64x64 matrix of nibbles times the 64 nibbles of that hash, each pair of rows giving one output byte,
 *      then xor with the hash
 *   3. cSHAKE256("HeavyHash") over the result, again one keccak-f1600
 * The hash is compared with the target as a little-endian 256-bit number.
 *
 * The matrix comes from the pre-pow hash (so it changes once per job, never per nonce) through xoshiro256++,
 * redrawn until it has full rank. The rank check is 64-bit floating point, which WGSL doesn't have, so the matrix
 * is always built here and handed to the GPU.
 */

const MASK64 = (1n << 64n) - 1n;

/** The initial keccak state of cSHAKE256("ProofOfWorkHash"), padding already folded in. */
const POW_STATE: bigint[] = [
  1242148031264380989n, 3008272977830772284n, 2188519011337848018n, 1992179434288343456n, 8876506674959887717n,
  5399642050693751366n, 1745875063082670864n, 8605242046444978844n, 17936695144567157056n, 3343109343542796272n,
  1123092876221303306n, 4963925045340115282n, 17037383077651887893n, 16629644495023626889n, 12833675776649114147n,
  3784524041015224902n, 1082795874807940378n, 13952716920571277634n, 13411128033953605860n, 15060696040649351053n,
  9928834659948351306n, 5237849264682708699n, 12825353012139217522n, 6706187291358897596n, 196324915476054915n,
];

/** The same for cSHAKE256("HeavyHash"), whose input is exactly 32 bytes. */
const HEAVY_STATE: bigint[] = [
  4239941492252378377n, 8746723911537738262n, 8796936657246353646n, 1272090201925444760n, 16654558671554924250n,
  8270816933120786537n, 13907396207649043898n, 6782861118970774626n, 9239690602118867528n, 11582319943599406348n,
  17596056728278508070n, 15212962468105129023n, 7812475424661425213n, 3370482334374859748n, 5690099369266491460n,
  8596393687355028144n, 570094237299545110n, 9119540418498120711n, 16901969272480492857n, 13372017233735502424n,
  14372891883993151831n, 5171152063242093102n, 10573107899694386186n, 6096431547456407061n, 1592359455985097269n,
];

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn,
  0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n,
  0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];

const rotl = (x: bigint, n: number): bigint => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;

/** The keccak-f1600 permutation over 25 lanes. */
export function f1600(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x][y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & b[(x + 2) % 5 + 5 * y]) & MASK64;
    }
    a[0] ^= RC[round];
  }
}

const leU64 = (bytes: Uint8Array, at: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
};
const putLeU64 = (bytes: Uint8Array, at: number, v: bigint): void => {
  for (let i = 0; i < 8; i++) bytes[at + i] = Number((v >> BigInt(8 * i)) & 0xffn);
};

/** Step 1: the proof-of-work hash of a header with this nonce. */
export function powHash(prePowHash: Uint8Array, timestamp: bigint, nonce: bigint): Uint8Array {
  const state = POW_STATE.slice();
  for (let i = 0; i < 4; i++) state[i] ^= leU64(prePowHash, i * 8);
  state[4] ^= timestamp;
  state[9] ^= nonce;
  f1600(state);
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) putLeU64(out, i * 8, state[i]);
  return out;
}

/** Step 3: the heavy hash of the matrix product. */
export function heavyHash(input: Uint8Array): Uint8Array {
  const state = HEAVY_STATE.slice();
  for (let i = 0; i < 4; i++) state[i] ^= leU64(input, i * 8);
  f1600(state);
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) putLeU64(out, i * 8, state[i]);
  return out;
}

/** Step 2 and 3: the matrix product of a proof-of-work hash, xored with it, then heavy-hashed. */
export function matrixHash(matrix: Uint8Array, hash: Uint8Array): Uint8Array {
  const vec = new Uint8Array(64);
  for (let i = 0; i < 32; i++) {
    vec[2 * i] = hash[i] >> 4;
    vec[2 * i + 1] = hash[i] & 0x0f;
  }
  const product = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    let sum1 = 0;
    let sum2 = 0;
    for (let j = 0; j < 64; j++) {
      sum1 += matrix[(2 * i) * 64 + j] * vec[j];
      sum2 += matrix[(2 * i + 1) * 64 + j] * vec[j];
    }
    product[i] = (((sum1 >> 10) << 4) | (sum2 >> 10)) ^ hash[i];
  }
  return heavyHash(product);
}

/** The whole thing: the hash a miner compares with the target. */
export function kHeavyHash(matrix: Uint8Array, prePowHash: Uint8Array, timestamp: bigint, nonce: bigint): Uint8Array {
  return matrixHash(matrix, powHash(prePowHash, timestamp, nonce));
}

/** xoshiro256++, seeded with the pre-pow hash. */
export class Xoshiro {
  private s: bigint[];
  constructor(seed: Uint8Array) {
    this.s = [0, 1, 2, 3].map((i) => leU64(seed, i * 8));
  }
  next(): bigint {
    const [s0, s1, s2, s3] = this.s;
    const res = (s0 + rotl((s0 + s3) & MASK64, 23)) & MASK64;
    const t = (s1 << 17n) & MASK64;
    let [n0, n1, n2, n3] = [s0, s1, s2 ^ s0, s3 ^ s1];
    n1 ^= n2;
    n0 ^= n3;
    n2 ^= t;
    n3 = rotl(n3, 45);
    this.s = [n0, n1, n2, n3];
    return res;
  }
}

/** Gaussian elimination in doubles, exactly as the node does it: the matrix is redrawn until this returns 64. */
export function rank(matrix: Uint8Array): number {
  const EPS = 1e-9;
  const m: Float64Array[] = [];
  for (let i = 0; i < 64; i++) {
    const row = new Float64Array(64);
    for (let j = 0; j < 64; j++) row[j] = matrix[i * 64 + j];
    m.push(row);
  }
  const selected = new Array(64).fill(false);
  let r = 0;
  for (let i = 0; i < 64; i++) {
    let j = 0;
    for (j = 0; j < 64; j++) if (!selected[j] && Math.abs(m[j][i]) > EPS) break;
    if (j !== 64) {
      r++;
      selected[j] = true;
      for (let p = i + 1; p < 64; p++) m[j][p] /= m[j][i];
      for (let k = 0; k < 64; k++) {
        if (k !== j && Math.abs(m[k][i]) > EPS) {
          for (let p = i + 1; p < 64; p++) m[k][p] -= m[j][p] * m[k][i];
        }
      }
    }
  }
  return r;
}

/** The job's matrix: drawn from the pre-pow hash, redrawn (from the same stream) until it has full rank. */
export function generateMatrix(prePowHash: Uint8Array): Uint8Array {
  const gen = new Xoshiro(prePowHash);
  for (;;) {
    const m = new Uint8Array(64 * 64);
    for (let i = 0; i < 64; i++) {
      let val = 0n;
      for (let j = 0; j < 64; j++) {
        if (j % 16 === 0) val = gen.next();
        m[i * 64 + j] = Number((val >> BigInt(4 * (j % 16))) & 0x0fn);
      }
    }
    if (rank(m) === 64) return m;
  }
}

/** Kaspa compares the hash with the target as a little-endian number. */
export function meetsTarget(hash: Uint8Array, target: Uint8Array): boolean {
  for (let i = 31; i >= 0; i--) {
    if (hash[i] !== target[i]) return hash[i] < target[i];
  }
  return true;
}

/** The target a stratum difficulty means: max (2^224 - 1) divided by it. */
export function targetFromDifficulty(difficulty: number): Uint8Array {
  const max = (1n << 224n) - 1n;
  const scaled = BigInt(Math.max(1, Math.round(difficulty * 1e8)));
  const t = (max * 100_000_000n) / scaled;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((t >> BigInt(8 * i)) & 0xffn);
  return out; // little-endian, the order the hash is compared in
}
