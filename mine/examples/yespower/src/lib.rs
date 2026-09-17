//! Proof-of-work nonce search for the yespower family (Sugarchain, Yenten, BSTY and friends), as a fly.ai
//! compute program. Split a coin's nonce space into ranges, one job each, and the network searches them.
//!
//! yespower is the one CPU proof-of-work worth running in a browser: 2 MB of scratchpad and 64-bit multiplies,
//! no JIT and no AES instructions, so WASM pays a few times over native rather than RandomX's 30x.
//!
//! Jobs have no network of their own: this finds nonces, and the bridge (../yespower-pool) submits them to a
//! mining pool.
//!
//! Input, 126 bytes plus the personalization string:
//!   76 bytes  the header without its nonce, as the coin serializes it
//!   u32 LE    first nonce
//!   u32 LE    how many nonces to try
//!   32 bytes  target, big-endian: a hash at or below it is a hit
//!   u8        version: 0 for yespower 0.5, 1 for yespower 1.0
//!   u32 LE    N (1024..512*1024, a power of two)
//!   u32 LE    r (8..32)
//!   u8        length of the personalization string, then its bytes
//! Output: u32 LE number of hits (at most 16), then for each: u32 LE nonce + the 32-byte hash.
//!
//!   cargo build --release --target wasm32-unknown-unknown

pub mod sha;
pub mod yespower;

use yespower::{yespower as hash, Scratch, Version};

/// A job's parameters, parsed from the input bytes.
pub struct Job<'a> {
    pub header: [u8; 80],
    pub first_nonce: u32,
    pub count: u32,
    pub target: [u8; 32],
    pub version: Version,
    pub n: u32,
    pub r: usize,
    pub pers: &'a [u8],
}

pub fn parse(input: &[u8]) -> Result<Job<'_>, &'static str> {
    if input.len() < 126 {
        return Err("input is at least 126 bytes");
    }
    let mut header = [0u8; 80];
    header[..76].copy_from_slice(&input[..76]);
    let u32at = |i: usize| u32::from_le_bytes([input[i], input[i + 1], input[i + 2], input[i + 3]]);
    let mut target = [0u8; 32];
    target.copy_from_slice(&input[84..116]);
    let version = match input[116] {
        0 => Version::V0_5,
        1 => Version::V1_0,
        _ => return Err("version is 0 (yespower 0.5) or 1 (yespower 1.0)"),
    };
    let n = u32at(117);
    let r = u32at(121) as usize;
    if n < 1024 || n > 512 * 1024 || (n & (n - 1)) != 0 {
        return Err("N is a power of two in 1024..524288");
    }
    if r < 8 || r > 32 {
        return Err("r is 8..32");
    }
    let pers_len = input[125] as usize;
    if input.len() < 126 + pers_len {
        return Err("personalization string is cut short");
    }
    Ok(Job { header, first_nonce: u32at(76), count: u32at(80), target, version, n, r, pers: &input[126..126 + pers_len] })
}

/// A hash at or below the target, compared big-endian as the coin does.
fn meets(hash: &[u8; 32], target: &[u8; 32]) -> bool {
    // the coins compare the hash as a little-endian number, i.e. reversed against the big-endian target
    for i in 0..32 {
        let h = hash[31 - i];
        let t = target[i];
        if h != t {
            return h < t;
        }
    }
    true
}

/// Search the job's nonce range; returns the hits in output format.
pub fn search(job: &Job<'_>) -> Vec<u8> {
    let mut scratch = Scratch::new(job.n, job.r);
    let mut header = job.header;
    let mut hits: Vec<(u32, [u8; 32])> = Vec::new();
    for i in 0..job.count {
        let nonce = job.first_nonce.wrapping_add(i);
        header[76..80].copy_from_slice(&nonce.to_le_bytes());
        let h = hash(&header, job.version, job.n, job.r, job.pers, &mut scratch);
        if meets(&h, &job.target) {
            hits.push((nonce, h));
            if hits.len() == 16 {
                break;
            }
        }
    }
    let mut out = Vec::with_capacity(4 + hits.len() * 36);
    out.extend_from_slice(&(hits.len() as u32).to_le_bytes());
    for (nonce, h) in hits {
        out.extend_from_slice(&nonce.to_le_bytes());
        out.extend_from_slice(&h);
    }
    out
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))] // the compute program itself; the WASI build below is only for the vector check
mod wasm {
    #[link(wasm_import_module = "flyai")]
    extern "C" {
        fn input_len() -> i32;
        fn input_read(ptr: *mut u8);
        fn output(ptr: *const u8, len: i32);
    }

    #[no_mangle]
    pub extern "C" fn run() {
        unsafe {
            let mut input = vec![0u8; input_len() as usize];
            input_read(input.as_mut_ptr());
            let out = match super::parse(&input) {
                Ok(job) => super::search(&job),
                Err(_) => 0u32.to_le_bytes().to_vec(), // a malformed job finds nothing
            };
            output(out.as_ptr(), out.len() as i32);
        }
    }
}
