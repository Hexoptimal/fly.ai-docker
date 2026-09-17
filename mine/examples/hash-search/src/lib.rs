//! Proof-of-work nonce search: double SHA-256 over an 80-byte block header (Bitcoin's scheme), across a nonce range.
//! Split a nonce space into ranges, one job each, and the network searches them in parallel.
//!
//! Jobs have no network: this finds nonces, and your own server submits them wherever they're needed (see
//! ../btc-pool for a bridge to a Bitcoin mining pool). Another coin needs its own hash function compiled here
//! instead of SHA-256d (RandomX for Monero, for example).
//!
//! Input, 116 bytes:
//!   76 bytes  the header without its nonce (version, previous hash, merkle root, time, bits), as serialized
//!   u32 LE    first nonce
//!   u32 LE    how many nonces to try
//!   32 bytes  target, big-endian: a hash (in display order, reversed) at or below it is a hit
//! Output: u32 LE number of hits (at most 64), then for each: u32 LE nonce + 32-byte hash in display order.
//!
//! Speed: the header's first 64 bytes never change within a job, so their SHA-256 state (the midstate) is computed
//! once; each nonce then costs two compressions with fixed padding and no allocation.
//!
//!   cargo build --release --target wasm32-unknown-unknown

#[link(wasm_import_module = "flyai")]
extern "C" {
    fn input_len() -> i32;
    fn input_read(ptr: *mut u8);
    fn output(ptr: *const u8, len: i32);
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const H0: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/// One SHA-256 compression of a 16-word block into the state.
fn compress(h: &mut [u32; 8], block: &[u32; 16]) {
    let mut w = [0u32; 64];
    w[..16].copy_from_slice(block);
    for i in 16..64 {
        let x = w[i - 15];
        w[i] = w[i - 16].wrapping_add(x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3))
            .wrapping_add(w[i - 7])
            .wrapping_add(w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10));
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = *h;
    for i in 0..64 {
        let t1 = hh.wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
            .wrapping_add((e & f) ^ (!e & g))
            .wrapping_add(K[i])
            .wrapping_add(w[i]);
        let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22)).wrapping_add((a & b) ^ (a & c) ^ (b & c));
        hh = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
        *x = x.wrapping_add(y);
    }
}

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap())
}

#[no_mangle]
pub extern "C" fn run() {
    let mut input = vec![0u8; unsafe { input_len() } as usize];
    unsafe { input_read(input.as_mut_ptr()) };
    assert!(input.len() == 116, "input is 116 bytes: header prefix, first nonce, count, target");
    let start = u32::from_le_bytes(input[76..80].try_into().unwrap());
    let count = u32::from_le_bytes(input[80..84].try_into().unwrap());
    let target: [u8; 32] = input[84..116].try_into().unwrap();
    let target_top = word(&target, 0);

    // header bytes 0..64: the midstate
    let mut first = [0u32; 16];
    for (i, w) in first.iter_mut().enumerate() {
        *w = word(&input, i * 4);
    }
    let mut mid = H0;
    compress(&mut mid, &first);

    // header bytes 64..80 (end of the merkle root, time, bits, nonce), then SHA-256 padding for 80 bytes
    let mut tail = [0u32; 16];
    tail[0] = word(&input, 64);
    tail[1] = word(&input, 68);
    tail[2] = word(&input, 72);
    tail[4] = 0x8000_0000;
    tail[15] = 80 * 8;
    // the second hash: 32 bytes of digest, then padding for 32 bytes
    let mut second = [0u32; 16];
    second[8] = 0x8000_0000;
    second[15] = 32 * 8;

    let mut hits: Vec<u8> = Vec::new();
    let mut found = 0u32;
    for k in 0..count {
        let nonce = start.wrapping_add(k);
        tail[3] = nonce.swap_bytes(); // the nonce is little-endian in the header; SHA-256 reads big-endian words
        let mut h1 = mid;
        compress(&mut h1, &tail);
        second[..8].copy_from_slice(&h1);
        let mut h2 = H0;
        compress(&mut h2, &second);
        // display order is the digest reversed, so its first word is the digest's last word byte-swapped
        if h2[7].swap_bytes() > target_top {
            continue;
        }
        let mut hash = [0u8; 32];
        for (i, x) in h2.iter().enumerate() {
            hash[i * 4..i * 4 + 4].copy_from_slice(&x.to_be_bytes());
        }
        hash.reverse();
        if hash <= target {
            hits.extend_from_slice(&nonce.to_le_bytes());
            hits.extend_from_slice(&hash);
            found += 1;
            if found == 64 {
                break;
            }
        }
    }
    let mut out = found.to_le_bytes().to_vec();
    out.extend_from_slice(&hits);
    unsafe { output(out.as_ptr(), out.len() as i32) };
}
