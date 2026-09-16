//! A 2048 x 2048 Mandelbrot image rendered as 64 tiles, one job each: order it with `count: 64`, and each job gets
//! its tile number. `stitch.ts` joins the outputs into one image.
//!
//! Input: 4 bytes, u32 LE tile number (0..63, row by row in an 8 x 8 grid).
//! Output: 256 x 256 u16 LE iteration counts (131,072 bytes); 0 means inside the set.
//! WebAssembly floats give the same bits on every machine, so miners agree exactly.
//!
//!   cargo build --release --target wasm32-unknown-unknown

#[link(wasm_import_module = "flyai")]
extern "C" {
    fn input_len() -> i32;
    fn input_read(ptr: *mut u8);
    fn output(ptr: *const u8, len: i32);
}

pub const GRID: u32 = 8;
pub const TILE: u32 = 256;
const MAX_ITER: u32 = 2000;
const X0: f64 = -2.2;
const X1: f64 = 1.0;
const Y0: f64 = -1.6;
const Y1: f64 = 1.6;

#[no_mangle]
pub extern "C" fn run() {
    let mut input = vec![0u8; unsafe { input_len() } as usize];
    unsafe { input_read(input.as_mut_ptr()) };
    let tile = u32::from_le_bytes(input[0..4].try_into().expect("input is a 4-byte tile number"));
    assert!(tile < GRID * GRID, "tile number is 0..63");
    let (tx, ty) = (tile % GRID, tile / GRID);
    let size = (GRID * TILE) as f64;

    let mut out = Vec::with_capacity((TILE * TILE * 2) as usize);
    for py in 0..TILE {
        for px in 0..TILE {
            let cx = X0 + (X1 - X0) * ((tx * TILE + px) as f64 + 0.5) / size;
            let cy = Y0 + (Y1 - Y0) * ((ty * TILE + py) as f64 + 0.5) / size;
            let (mut x, mut y, mut i) = (0.0f64, 0.0f64, 0u32);
            while i < MAX_ITER && x * x + y * y <= 4.0 {
                let t = x * x - y * y + cx;
                y = 2.0 * x * y + cy;
                x = t;
                i += 1;
            }
            let v: u16 = if i == MAX_ITER { 0 } else { (i as u16).max(1) };
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    unsafe { output(out.as_ptr(), out.len() as i32) };
}
