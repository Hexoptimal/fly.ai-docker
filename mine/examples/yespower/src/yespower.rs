//! yespower 0.5 and 1.0, ported from the reference implementation (yespower-ref.c, BSD-2-Clause,
//! Alexander Peslyak / Solar Designer). Pure Rust with no dependencies so it compiles to wasm32, which the
//! optimized C can't: that one is hand-written SSE/AVX.
//!
//! yespower is deliberately CPU-friendly and GPU-hostile: 2 MB of scratchpad per hash, random reads, and 64-bit
//! multiplies. That is why it is the one CPU proof-of-work worth running in a browser - the WASM penalty is a
//! few times, not the 30x that RandomX pays for having no JIT.
//!
//! Checked against the reference's own published vectors (TESTS-OK) in tests/vectors.rs.

use crate::sha::{hmac_sha256, pbkdf2_sha256_1, sha256};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Version {
    V0_5,
    V1_0,
}

const PWX_SIMPLE: usize = 2;
const PWX_GATHER: usize = 4;
const PWX_BYTES: usize = PWX_GATHER * PWX_SIMPLE * 8; // 64
const PWX_WORDS: usize = PWX_BYTES / 4; // 16

/// The S-boxes and where pwxform is writing into them.
struct Ctx {
    version: Version,
    salsa20_rounds: u32,
    pwx_rounds: usize,
    swidth: u32,
    smask: u32,
    s: Vec<u32>,
    /// word offsets into `s` of the three S-boxes; they rotate after every pwxform
    s0: usize,
    s1: usize,
    s2: usize,
    w: usize,
}

/// The Salsa20 core over 16 words, in yespower's SIMD-shuffled order.
fn salsa20(b: &mut [u32], rounds: u32) {
    let mut x = [0u32; 16];
    for i in 0..16 {
        x[i * 5 % 16] = b[i];
    }
    macro_rules! r {
        ($a:expr, $n:expr) => {
            $a.rotate_left($n)
        };
    }
    let mut i = 0;
    while i < rounds {
        // columns
        x[4] ^= r!(x[0].wrapping_add(x[12]), 7);
        x[8] ^= r!(x[4].wrapping_add(x[0]), 9);
        x[12] ^= r!(x[8].wrapping_add(x[4]), 13);
        x[0] ^= r!(x[12].wrapping_add(x[8]), 18);
        x[9] ^= r!(x[5].wrapping_add(x[1]), 7);
        x[13] ^= r!(x[9].wrapping_add(x[5]), 9);
        x[1] ^= r!(x[13].wrapping_add(x[9]), 13);
        x[5] ^= r!(x[1].wrapping_add(x[13]), 18);
        x[14] ^= r!(x[10].wrapping_add(x[6]), 7);
        x[2] ^= r!(x[14].wrapping_add(x[10]), 9);
        x[6] ^= r!(x[2].wrapping_add(x[14]), 13);
        x[10] ^= r!(x[6].wrapping_add(x[2]), 18);
        x[3] ^= r!(x[15].wrapping_add(x[11]), 7);
        x[7] ^= r!(x[3].wrapping_add(x[15]), 9);
        x[11] ^= r!(x[7].wrapping_add(x[3]), 13);
        x[15] ^= r!(x[11].wrapping_add(x[7]), 18);
        // rows
        x[1] ^= r!(x[0].wrapping_add(x[3]), 7);
        x[2] ^= r!(x[1].wrapping_add(x[0]), 9);
        x[3] ^= r!(x[2].wrapping_add(x[1]), 13);
        x[0] ^= r!(x[3].wrapping_add(x[2]), 18);
        x[6] ^= r!(x[5].wrapping_add(x[4]), 7);
        x[7] ^= r!(x[6].wrapping_add(x[5]), 9);
        x[4] ^= r!(x[7].wrapping_add(x[6]), 13);
        x[5] ^= r!(x[4].wrapping_add(x[7]), 18);
        x[11] ^= r!(x[10].wrapping_add(x[9]), 7);
        x[8] ^= r!(x[11].wrapping_add(x[10]), 9);
        x[9] ^= r!(x[8].wrapping_add(x[11]), 13);
        x[10] ^= r!(x[9].wrapping_add(x[8]), 18);
        x[12] ^= r!(x[15].wrapping_add(x[14]), 7);
        x[13] ^= r!(x[12].wrapping_add(x[15]), 9);
        x[14] ^= r!(x[13].wrapping_add(x[12]), 13);
        x[15] ^= r!(x[14].wrapping_add(x[13]), 18);
        i += 2;
    }
    for i in 0..16 {
        b[i] = b[i].wrapping_add(x[i * 5 % 16]);
    }
}

/// BlockMix with Salsa20 over 128 bytes.
fn blockmix_salsa(b: &mut [u32], rounds: u32) {
    let mut x = [0u32; 16];
    x.copy_from_slice(&b[16..32]);
    for i in 0..2 {
        for k in 0..16 {
            x[k] ^= b[i * 16 + k];
        }
        salsa20(&mut x, rounds);
        b[i * 16..i * 16 + 16].copy_from_slice(&x);
    }
}

/// The heart of yespower: 64-bit multiplies against S-box lookups, writing back into the S-boxes as it goes.
fn pwxform(x: &mut [u32], ctx: &mut Ctx) {
    let smask = ctx.smask as usize;
    let mut w = ctx.w;
    let (s0, s1, s2) = (ctx.s0, ctx.s1, ctx.s2);
    for i in 0..ctx.pwx_rounds {
        for j in 0..PWX_GATHER {
            let xl = x[j * PWX_SIMPLE * 2] as usize;
            let xh = x[j * PWX_SIMPLE * 2 + 1] as usize;
            // each S-box entry is two words (8 bytes); the mask picks a byte offset
            let p0 = s0 + (xl & smask) / 4;
            let p1 = s1 + (xh & smask) / 4;
            for k in 0..PWX_SIMPLE {
                let sv0 = ((ctx.s[p0 + k * 2 + 1] as u64) << 32) + ctx.s[p0 + k * 2] as u64;
                let sv1 = ((ctx.s[p1 + k * 2 + 1] as u64) << 32) + ctx.s[p1 + k * 2] as u64;
                let lo = x[(j * PWX_SIMPLE + k) * 2] as u64;
                let hi = x[(j * PWX_SIMPLE + k) * 2 + 1] as u64;
                let mut v = hi.wrapping_mul(lo);
                v = v.wrapping_add(sv0);
                v ^= sv1;
                x[(j * PWX_SIMPLE + k) * 2] = v as u32;
                x[(j * PWX_SIMPLE + k) * 2 + 1] = (v >> 32) as u32;
            }
            if ctx.version != Version::V0_5 && (i == 0 || j < PWX_GATHER / 2) {
                if j & 1 != 0 {
                    for k in 0..PWX_SIMPLE {
                        ctx.s[s1 + w * 2] = x[(j * PWX_SIMPLE + k) * 2];
                        ctx.s[s1 + w * 2 + 1] = x[(j * PWX_SIMPLE + k) * 2 + 1];
                        w += 1;
                    }
                } else {
                    for k in 0..PWX_SIMPLE {
                        ctx.s[s0 + (w + k) * 2] = x[(j * PWX_SIMPLE + k) * 2];
                        ctx.s[s0 + (w + k) * 2 + 1] = x[(j * PWX_SIMPLE + k) * 2 + 1];
                    }
                }
            }
        }
    }
    if ctx.version != Version::V0_5 {
        ctx.s0 = s2;
        ctx.s1 = s0;
        ctx.s2 = s1;
        ctx.w = w & ((1usize << ctx.swidth) * PWX_SIMPLE - 1);
    }
}

/// BlockMix with pwxform over 128r bytes.
fn blockmix_pwxform(b: &mut [u32], ctx: &mut Ctx, r: usize) {
    let r1 = 128 * r / PWX_BYTES;
    let mut x = [0u32; PWX_WORDS];
    x.copy_from_slice(&b[(r1 - 1) * PWX_WORDS..(r1 - 1) * PWX_WORDS + PWX_WORDS]);
    for i in 0..r1 {
        if r1 > 1 {
            for k in 0..PWX_WORDS {
                x[k] ^= b[i * PWX_WORDS + k];
            }
        }
        pwxform(&mut x, ctx);
        b[i * PWX_WORDS..i * PWX_WORDS + PWX_WORDS].copy_from_slice(&x);
    }
    let mut i = (r1 - 1) * PWX_BYTES / 64;
    salsa20(&mut b[i * 16..i * 16 + 16], ctx.salsa20_rounds);
    i += 1;
    while i < 2 * r {
        for k in 0..16 {
            b[i * 16 + k] ^= b[(i - 1) * 16 + k];
        }
        salsa20(&mut b[i * 16..i * 16 + 16], ctx.salsa20_rounds);
        i += 1;
    }
}

fn integerify(x: &[u32], r: usize) -> u32 {
    x[(2 * r - 1) * 16]
}

fn p2floor(mut x: u32) -> u32 {
    loop {
        let y = x & x.wrapping_sub(1);
        if y == 0 {
            return x;
        }
        x = y;
    }
}

fn wrap(x: u32, i: u32) -> u32 {
    let n = p2floor(i);
    (x & (n - 1)).wrapping_add(i - n)
}

/// First SMix loop. `v_is_s` means we are filling the S-boxes, where BlockMix uses Salsa20 instead of pwxform.
fn smix1(b: &mut [u32], r: usize, n: u32, v: &mut [u32], x: &mut [u32], ctx: &mut Ctx, v_is_s: bool) {
    let s = 32 * r;
    for k in 0..2 * r {
        for i in 0..16 {
            x[k * 16 + i] = b[k * 16 + (i * 5 % 16)];
        }
    }
    if ctx.version != Version::V0_5 {
        for k in 1..r {
            let (left, right) = x.split_at_mut(k * 32);
            right[..32].copy_from_slice(&left[(k - 1) * 32..(k - 1) * 32 + 32]);
            blockmix_pwxform(&mut right[..32], ctx, 1);
        }
    }
    for i in 0..n {
        let i = i as usize;
        if v_is_s {
            ctx.s[i * s..i * s + s].copy_from_slice(&x[..s]);
        } else {
            v[i * s..i * s + s].copy_from_slice(&x[..s]);
        }
        if i > 1 {
            let j = wrap(integerify(x, r), i as u32) as usize;
            for k in 0..s {
                x[k] ^= if v_is_s { ctx.s[j * s + k] } else { v[j * s + k] };
            }
        }
        if v_is_s {
            blockmix_salsa(x, ctx.salsa20_rounds);
        } else {
            blockmix_pwxform(x, ctx, r);
        }
    }
    for k in 0..2 * r {
        for i in 0..16 {
            b[k * 16 + (i * 5 % 16)] = x[k * 16 + i];
        }
    }
}

/// Second SMix loop.
fn smix2(b: &mut [u32], r: usize, n: u32, nloop: u32, v: &mut [u32], x: &mut [u32], ctx: &mut Ctx) {
    let s = 32 * r;
    for k in 0..2 * r {
        for i in 0..16 {
            x[k * 16 + i] = b[k * 16 + (i * 5 % 16)];
        }
    }
    for _ in 0..nloop {
        let j = (integerify(x, r) & (n - 1)) as usize;
        for k in 0..s {
            x[k] ^= v[j * s + k];
        }
        if nloop != 2 {
            v[j * s..j * s + s].copy_from_slice(&x[..s]);
        }
        blockmix_pwxform(x, ctx, r);
    }
    for k in 0..2 * r {
        for i in 0..16 {
            b[k * 16 + (i * 5 % 16)] = x[k * 16 + i];
        }
    }
}

/// Scratchpad big enough for the biggest parameters a caller will use, reused across nonces.
pub struct Scratch {
    v: Vec<u32>,
    x: Vec<u32>,
    b: Vec<u32>,
}

impl Scratch {
    pub fn new(n: u32, r: usize) -> Scratch {
        let b_words = 32 * r;
        Scratch { v: vec![0; b_words * n as usize], x: vec![0; b_words], b: vec![0; b_words] }
    }
}

/// yespower(src) with the given parameters. `pers` is the coin's personalization string (often empty).
pub fn yespower(src: &[u8], version: Version, n: u32, r: usize, pers: &[u8], scratch: &mut Scratch) -> [u8; 32] {
    let swidth: u32 = if version == Version::V0_5 { 8 } else { 11 };
    let sbytes = if version == Version::V0_5 {
        2 * (1usize << swidth) * PWX_SIMPLE * 8
    } else {
        3 * (1usize << swidth) * PWX_SIMPLE * 8
    };
    let mut ctx = Ctx {
        version,
        salsa20_rounds: if version == Version::V0_5 { 8 } else { 2 },
        pwx_rounds: if version == Version::V0_5 { 6 } else { 3 },
        swidth,
        smask: (((1u32 << swidth) - 1) * (PWX_SIMPLE as u32) * 8),
        s: vec![0; sbytes / 4],
        s0: 0,
        s1: (1usize << swidth) * PWX_SIMPLE * 2,
        s2: 2 * (1usize << swidth) * PWX_SIMPLE * 2,
        w: 0,
    };
    let b_size = 128 * r;
    let b_words = b_size / 4;
    if scratch.b.len() < b_words {
        *scratch = Scratch::new(n, r);
    }

    let mut key = sha256(src);
    let salt: &[u8] = if version == Version::V0_5 { src } else { pers };

    let mut b_bytes = vec![0u8; b_size];
    pbkdf2_sha256_1(&key, salt, &mut b_bytes);
    for i in 0..b_words {
        scratch.b[i] = u32::from_le_bytes([b_bytes[i * 4], b_bytes[i * 4 + 1], b_bytes[i * 4 + 2], b_bytes[i * 4 + 3]]);
    }
    // the first 32 bytes of B become the key for the final step
    key.copy_from_slice(&b_bytes[..32]);

    // smix: S-boxes first (which uses ctx.s as its own V), then the two main loops
    let mut nloop_all = (n + 2) / 3;
    let mut nloop_rw = nloop_all;
    nloop_all = (nloop_all + 1) & !1u32;
    if version == Version::V0_5 {
        nloop_rw &= !1u32;
    } else {
        nloop_rw = (nloop_rw + 1) & !1u32;
    }
    let s_blocks = (sbytes / 128) as u32;
    {
        let (b, x) = (&mut scratch.b, &mut scratch.x);
        let mut empty: Vec<u32> = Vec::new();
        smix1(&mut b[..32], 1, s_blocks, &mut empty, x, &mut ctx, true);
    }
    smix1(&mut scratch.b, r, n, &mut scratch.v, &mut scratch.x, &mut ctx, false);
    smix2(&mut scratch.b, r, n, nloop_rw, &mut scratch.v, &mut scratch.x, &mut ctx);
    smix2(&mut scratch.b, r, n, nloop_all - nloop_rw, &mut scratch.v, &mut scratch.x, &mut ctx);

    for i in 0..b_words {
        b_bytes[i * 4..i * 4 + 4].copy_from_slice(&scratch.b[i].to_le_bytes());
    }
    if version == Version::V0_5 {
        let mut out = [0u8; 32];
        pbkdf2_sha256_1(&key, &b_bytes, &mut out);
        if !pers.is_empty() {
            let inner = hmac_sha256(&out, pers);
            out = sha256(&inner);
        }
        out
    } else {
        hmac_sha256(&b_bytes[b_size - 64..], &key)
    }
}
