// kHeavyHash (Kaspa's proof-of-work) on the GPU: each invocation searches a slice of a nonce range and writes the
// nonces whose hash met the target. One hash is two keccak-f1600 permutations with a 64x64 nibble matrix multiply
// between them (see ../kaspa/khh.ts for the same thing in TypeScript, checked against Kaspa's own test vectors).
//
// WGSL has no 64-bit integers, so every keccak lane is a vec2<u32> of (low, high) words. The matrix comes from the
// job (its rank check is 64-bit floating point, which WGSL also lacks), packed eight nibbles to a word.
//
// Input, 2132 bytes:
//   0..32     pre-pow hash
//   32..40    timestamp, u64 LE
//   40..48    first nonce, u64 LE
//   48..52    nonces per invocation, u32
//   52..84    target, little-endian as the hash is compared
//   84..2132  the 64x64 matrix, eight nibbles per word, row after row
// Output, 644 bytes: u32 count, then for each hit: nonce low, nonce high, and 8 words of hash. The count can
// exceed what fits; only the first (output_bytes - 4) / 40 hits are written, which is what the bridge reads.

@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<atomic<u32>>;
struct Job { index: u32, input_bytes: u32, output_bytes: u32, pad: u32 }
@group(0) @binding(2) var<uniform> job: Job;

const ROT = array<u32, 25>(0u, 1u, 62u, 28u, 27u, 36u, 44u, 6u, 55u, 20u, 3u, 10u, 43u, 25u, 39u, 41u, 45u, 15u, 21u, 8u, 18u, 2u, 61u, 56u, 14u);
const PI = array<u32, 25>(0u, 10u, 20u, 5u, 15u, 16u, 1u, 11u, 21u, 6u, 7u, 17u, 2u, 12u, 22u, 23u, 8u, 18u, 3u, 13u, 14u, 24u, 9u, 19u, 4u);

// the initial keccak state of cSHAKE256("ProofOfWorkHash"), padding folded in, as (low, high) pairs
const POW_STATE = array<vec2<u32>, 25>(
  vec2<u32>(0xa1f6d83du, 0x113cff0du), vec2<u32>(0xb7027e3cu, 0x29bf8855u), vec2<u32>(0x0efb44d2u, 0x1e5f2e72u),
  vec2<u32>(0xf59869a0u, 0x1ba5a4a3u), vec2<u32>(0x875e2d65u, 0x7b2fafcau), vec2<u32>(0x29dce246u, 0x4aef61d6u),
  vec2<u32>(0xad415b10u, 0x183a981eu), vec2<u32>(0x789bc29cu, 0x776bf60cu), vec2<u32>(0x88663140u, 0xf8ebf133u),
  vec2<u32>(0x43285ff0u, 0x2e651c3cu), vec2<u32>(0x40f14a0au, 0x0f960705u), vec2<u32>(0x5b299152u, 0x44e36787u),
  vec2<u32>(0x25b13715u, 0xec70f1a4u), vec2<u32>(0x82e9da89u, 0xe6c85d8fu), vec2<u32>(0x85b4b223u, 0xb21a601fu),
  vec2<u32>(0x64a36a46u, 0x34855490u), vec2<u32>(0x7a2f851au, 0x0f06dd1cu), vec2<u32>(0x563bb142u, 0xc1a2021du),
  vec2<u32>(0x451668e4u, 0xba1de5e4u), vec2<u32>(0x05095f8du, 0xd1025741u), vec2<u32>(0x9bcecf4au, 0x89ca4e84u),
  vec2<u32>(0xa8742edbu, 0x48b09427u), vec2<u32>(0xe78b5272u, 0xb1fcce9cu), vec2<u32>(0x82afa5bcu, 0x5d1129cfu),
  vec2<u32>(0x6f824383u, 0x02b97c78u),
);
// the same for cSHAKE256("HeavyHash")
const HEAVY_STATE = array<vec2<u32>, 25>(
  vec2<u32>(0xb2248509u, 0x3ad74c52u), vec2<u32>(0x2f9f4216u, 0x79629b0eu), vec2<u32>(0x16c7f8eeu, 0x7a14ff48u),
  vec2<u32>(0x80056498u, 0x11a75f4cu), vec2<u32>(0x44eecedau, 0xe720e0dfu), vec2<u32>(0x14f34069u, 0x72c7d82eu),
  vec2<u32>(0x938935bau, 0xc100ff2au), vec2<u32>(0x250fc462u, 0x5e219040u), vec2<u32>(0x0dcf6a48u, 0x8039f9a6u),
  vec2<u32>(0x792a3d0cu, 0xa0bcaa9fu), vec2<u32>(0xd0a9a226u, 0xf431c05du), vec2<u32>(0x54c18c3fu, 0xd31f4cc3u),
  vec2<u32>(0xa769cc3du, 0x6c6b7d01u), vec2<u32>(0x562493e4u, 0x2ec65bd3u), vec2<u32>(0x99cdb044u, 0x4ef74b3au),
  vec2<u32>(0x5434f2b0u, 0x774c8683u), vec2<u32>(0x36bc9416u, 0x07e961b0u), vec2<u32>(0x7765cc07u, 0x7e8f1db1u),
  vec2<u32>(0xbac46d39u, 0xea8fdb80u), vec2<u32>(0x7b34ca58u, 0xb992f2d3u), vec2<u32>(0x8481b957u, 0xc776c504u),
  vec2<u32>(0x5112c22eu, 0x47c39f67u), vec2<u32>(0xb5290c0au, 0x92bb399du), vec2<u32>(0x2f9fc615u, 0x549ae031u),
  vec2<u32>(0x10b9da35u, 0x1619327du),
);
const RC = array<vec2<u32>, 24>(
  vec2<u32>(0x00000001u, 0x00000000u), vec2<u32>(0x00008082u, 0x00000000u), vec2<u32>(0x0000808au, 0x80000000u),
  vec2<u32>(0x80008000u, 0x80000000u), vec2<u32>(0x0000808bu, 0x00000000u), vec2<u32>(0x80000001u, 0x00000000u),
  vec2<u32>(0x80008081u, 0x80000000u), vec2<u32>(0x00008009u, 0x80000000u), vec2<u32>(0x0000008au, 0x00000000u),
  vec2<u32>(0x00000088u, 0x00000000u), vec2<u32>(0x80008009u, 0x00000000u), vec2<u32>(0x8000000au, 0x00000000u),
  vec2<u32>(0x8000808bu, 0x00000000u), vec2<u32>(0x0000008bu, 0x80000000u), vec2<u32>(0x00008089u, 0x80000000u),
  vec2<u32>(0x00008003u, 0x80000000u), vec2<u32>(0x00008002u, 0x80000000u), vec2<u32>(0x00000080u, 0x80000000u),
  vec2<u32>(0x0000800au, 0x00000000u), vec2<u32>(0x8000000au, 0x80000000u), vec2<u32>(0x80008081u, 0x80000000u),
  vec2<u32>(0x00008080u, 0x80000000u), vec2<u32>(0x80000001u, 0x00000000u), vec2<u32>(0x80008008u, 0x80000000u),
);

fn rotl64(x: vec2<u32>, n: u32) -> vec2<u32> {
  if (n == 0u) { return x; }
  if (n == 32u) { return vec2<u32>(x.y, x.x); }
  if (n < 32u) {
    return vec2<u32>((x.x << n) | (x.y >> (32u - n)), (x.y << n) | (x.x >> (32u - n)));
  }
  let m = n - 32u;
  return vec2<u32>((x.y << m) | (x.x >> (32u - m)), (x.x << m) | (x.y >> (32u - m)));
}

fn f1600(state: ptr<function, array<vec2<u32>, 25>>) {
  for (var round = 0u; round < 24u; round = round + 1u) {
    // theta
    var c: array<vec2<u32>, 5>;
    for (var x = 0u; x < 5u; x = x + 1u) {
      c[x] = (*state)[x] ^ (*state)[x + 5u] ^ (*state)[x + 10u] ^ (*state)[x + 15u] ^ (*state)[x + 20u];
    }
    var d: array<vec2<u32>, 5>;
    for (var x = 0u; x < 5u; x = x + 1u) {
      d[x] = c[(x + 4u) % 5u] ^ rotl64(c[(x + 1u) % 5u], 1u);
    }
    for (var x = 0u; x < 5u; x = x + 1u) {
      for (var y = 0u; y < 5u; y = y + 1u) {
        (*state)[x + 5u * y] = (*state)[x + 5u * y] ^ d[x];
      }
    }
    // rho and pi
    var b: array<vec2<u32>, 25>;
    for (var i = 0u; i < 25u; i = i + 1u) {
      b[PI[i]] = rotl64((*state)[i], ROT[i]);
    }
    // chi
    for (var y = 0u; y < 5u; y = y + 1u) {
      for (var x = 0u; x < 5u; x = x + 1u) {
        (*state)[x + 5u * y] = b[x + 5u * y] ^ (~b[(x + 1u) % 5u + 5u * y] & b[(x + 2u) % 5u + 5u * y]);
      }
    }
    // iota
    (*state)[0] = (*state)[0] ^ RC[round];
  }
}

/// A byte of the input buffer.
fn byteAt(offset: u32) -> u32 {
  return (input[offset / 4u] >> (8u * (offset % 4u))) & 0xffu;
}

/// A lane of the input buffer, little-endian.
fn laneAt(offset: u32) -> vec2<u32> {
  return vec2<u32>(input[offset / 4u], input[offset / 4u + 1u]);
}

/// A nibble of the matrix: row-major, eight to a word.
fn matrixAt(row: u32, col: u32) -> u32 {
  let at = row * 64u + col;
  return (input[21u + at / 8u] >> (4u * (at % 8u))) & 0xfu;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let perThread = input[12];                         // nonces this invocation walks
  let prePow = array<vec2<u32>, 4>(laneAt(0u), laneAt(8u), laneAt(16u), laneAt(24u));
  let timestamp = laneAt(32u);
  let firstNonce = laneAt(40u);
  // nonce = firstNonce + gid.x * perThread + i, as a 64-bit add
  let offset0 = gid.x * perThread;
  for (var i = 0u; i < perThread; i = i + 1u) {
    let add = offset0 + i;
    var nonce = vec2<u32>(firstNonce.x + add, firstNonce.y);
    if (nonce.x < firstNonce.x) { nonce.y = nonce.y + 1u; }   // carry

    // step 1: the proof-of-work hash
    var state: array<vec2<u32>, 25>;
    for (var k = 0u; k < 25u; k = k + 1u) { state[k] = POW_STATE[k]; }
    for (var k = 0u; k < 4u; k = k + 1u) { state[k] = state[k] ^ prePow[k]; }
    state[4] = state[4] ^ timestamp;
    state[9] = state[9] ^ nonce;
    f1600(&state);
    var powBytes: array<u32, 32>;
    for (var k = 0u; k < 4u; k = k + 1u) {
      for (var b = 0u; b < 4u; b = b + 1u) {
        powBytes[k * 8u + b] = (state[k].x >> (8u * b)) & 0xffu;
        powBytes[k * 8u + 4u + b] = (state[k].y >> (8u * b)) & 0xffu;
      }
    }

    // step 2: the matrix product, then xor with the hash
    var vec64: array<u32, 64>;
    for (var k = 0u; k < 32u; k = k + 1u) {
      vec64[2u * k] = powBytes[k] >> 4u;
      vec64[2u * k + 1u] = powBytes[k] & 0xfu;
    }
    var product: array<u32, 32>;
    for (var k = 0u; k < 32u; k = k + 1u) {
      var sum1 = 0u;
      var sum2 = 0u;
      for (var j = 0u; j < 64u; j = j + 1u) {
        sum1 = sum1 + matrixAt(2u * k, j) * vec64[j];
        sum2 = sum2 + matrixAt(2u * k + 1u, j) * vec64[j];
      }
      product[k] = ((((sum1 >> 10u) << 4u) | (sum2 >> 10u)) ^ powBytes[k]) & 0xffu;
    }

    // step 3: the heavy hash
    var hstate: array<vec2<u32>, 25>;
    for (var k = 0u; k < 25u; k = k + 1u) { hstate[k] = HEAVY_STATE[k]; }
    for (var k = 0u; k < 4u; k = k + 1u) {
      var lo = 0u;
      var hi = 0u;
      for (var b = 0u; b < 4u; b = b + 1u) {
        lo = lo | (product[k * 8u + b] << (8u * b));
        hi = hi | (product[k * 8u + 4u + b] << (8u * b));
      }
      hstate[k] = hstate[k] ^ vec2<u32>(lo, hi);
    }
    f1600(&hstate);

    // the hash against the target, little-endian: compare from the top byte down
    var meets = true;
    for (var k = 3u; ; k = k - 1u) {
      let h = hstate[k];
      let t = vec2<u32>(input[13u + k * 2u], input[13u + k * 2u + 1u]);
      if (h.y != t.y) { meets = h.y < t.y; break; }
      if (h.x != t.x) { meets = h.x < t.x; break; }
      if (k == 0u) { break; }
    }
    if (meets) {
      let maxHits = (job.output_bytes - 4u) / 40u;   // however many the order's output_bytes has room for
      let slot = atomicAdd(&output[0], 1u);
      if (slot < maxHits) {
        let at = 1u + slot * 10u;
        atomicStore(&output[at], nonce.x);
        atomicStore(&output[at + 1u], nonce.y);
        for (var k = 0u; k < 4u; k = k + 1u) {
          atomicStore(&output[at + 2u + k * 2u], hstate[k].x);
          atomicStore(&output[at + 2u + k * 2u + 1u], hstate[k].y);
        }
      }
    }
  }
}

// The order runs at redundancy 1: two GPUs would agree on WHICH nonces qualify but not on the order the atomic
// counter hands out slots, so their outputs would differ. The bridge re-hashes every hit anyway, so a miner can
// only hide a share, never invent one.
