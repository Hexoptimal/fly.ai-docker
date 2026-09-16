//! Monte Carlo pi on fly.ai compute, using the `flyai` imports (no WASI).
//!
//! Input, either:
//!   4 bytes  (a `count` job: its job number, u32 LE) -> seed = job number + 1, 5,000,000 samples
//!   12 bytes (uploaded inputs): u64 seed, u32 samples, little-endian
//! Output: 8 bytes, little-endian u64: how many random points fell inside the quarter circle.
//!
//! Add the counts over all jobs: pi ≈ 4 * hits / (jobs * samples). Integer math only, so every miner agrees.
//!
//!   cargo build --release --target wasm32-unknown-unknown

#[link(wasm_import_module = "flyai")]
extern "C" {
    fn input_len() -> i32;
    fn input_read(ptr: *mut u8);
    fn output(ptr: *const u8, len: i32);
}

#[no_mangle]
pub extern "C" fn run() {
    let mut input = vec![0u8; unsafe { input_len() } as usize];
    unsafe { input_read(input.as_mut_ptr()) };
    let (seed, samples) = match input.len() {
        4 => (u32::from_le_bytes(input[0..4].try_into().unwrap()) as u64 + 1, 5_000_000u32),
        12 => (u64::from_le_bytes(input[0..8].try_into().unwrap()), u32::from_le_bytes(input[8..12].try_into().unwrap())),
        _ => panic!("input is 4 bytes (a job number) or 12 bytes (u64 seed, u32 samples)"),
    };
    // splitmix the seed so neighbouring job numbers start far apart, then xorshift64*
    let mut state = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    state = (state ^ (state >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    state = (state ^ (state >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB) | 1;
    let mut next = || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33
    };
    let radius2 = (1u64 << 31) * (1u64 << 31);
    let mut hits: u64 = 0;
    for _ in 0..samples {
        let (x, y) = (next(), next());
        if x * x + y * y < radius2 {
            hits += 1;
        }
    }
    let bytes = hits.to_le_bytes();
    unsafe { output(bytes.as_ptr(), bytes.len() as i32) };
}
