//! Travelling salesman by random restarts: 60 fixed cities, and each job starts from its own random tour and improves
//! it with 2-opt until nothing helps. Order `count: N` for N restarts and keep the shortest tour: more miners, more
//! restarts, a better answer. The same pattern fits any search with random restarts (SAT, scheduling, packing).
//!
//! Input: 4 bytes, u32 LE job number (the restart's seed).
//! Output: u32 LE tour length (rounded), then 60 bytes: the city order.
//!
//!   cargo build --release --target wasm32-unknown-unknown

#[link(wasm_import_module = "flyai")]
extern "C" {
    fn input_len() -> i32;
    fn input_read(ptr: *mut u8);
    fn output(ptr: *const u8, len: i32);
}

const CITIES: usize = 60;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// The map: the same 60 cities for every job, on a 1000 x 1000 square (integer coordinates).
fn cities() -> [(i64, i64); CITIES] {
    let mut rng = Rng(0x5eed_c171_e5);
    let mut out = [(0, 0); CITIES];
    for c in out.iter_mut() {
        *c = ((rng.next() % 1000) as i64, (rng.next() % 1000) as i64);
    }
    out
}

/// Integer distances (rounded), so tour lengths are exact on every machine.
fn dist(a: (i64, i64), b: (i64, i64)) -> i64 {
    let d2 = ((a.0 - b.0).pow(2) + (a.1 - b.1).pow(2)) as u64;
    let mut r = (d2 as f64).sqrt() as u64; // then fix any rounding of sqrt
    while r * r > d2 {
        r -= 1;
    }
    while (r + 1) * (r + 1) <= d2 {
        r += 1;
    }
    r as i64
}

#[no_mangle]
pub extern "C" fn run() {
    let mut input = vec![0u8; unsafe { input_len() } as usize];
    unsafe { input_read(input.as_mut_ptr()) };
    let seed = u32::from_le_bytes(input[0..4].try_into().expect("input is a 4-byte job number")) as u64;
    let map = cities();
    let d = |a: u8, b: u8| dist(map[a as usize], map[b as usize]);

    let mut rng = Rng((seed + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut tour: Vec<u8> = (0..CITIES as u8).collect();
    for i in (1..CITIES).rev() {
        tour.swap(i, (rng.next() % (i as u64 + 1)) as usize);
    }
    loop {
        let mut improved = false;
        for i in 0..CITIES - 1 {
            for j in i + 2..CITIES {
                let (a, b, c, e) = (tour[i], tour[i + 1], tour[j], tour[(j + 1) % CITIES]);
                if d(a, c) + d(b, e) < d(a, b) + d(c, e) {
                    tour[i + 1..=j].reverse();
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
    }
    let length: i64 = (0..CITIES).map(|i| d(tour[i], tour[(i + 1) % CITIES])).sum();
    let mut out = (length as u32).to_le_bytes().to_vec();
    out.extend_from_slice(&tour);
    unsafe { output(out.as_ptr(), out.len() as i32) };
}
