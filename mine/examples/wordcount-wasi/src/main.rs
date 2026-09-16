//! Word count on fly.ai compute as an ordinary program: WASI stdin is the job's input, stdout is its output.
//! Any language that targets wasm32-wasip1 works the same way (Rust, C with wasi-sdk, Zig, TinyGo).
//!
//! Input:  UTF-8 text.
//! Output: one line per word, "count word", most common first (ties alphabetical).
//!
//!   cargo build --release --target wasm32-wasip1

use std::collections::HashMap;
use std::io::{self, Read, Write};

fn main() {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text).expect("input must be UTF-8 text");

    let mut counts: HashMap<String, u64> = HashMap::new();
    for word in text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        *counts.entry(word.to_lowercase()).or_default() += 1;
    }
    // HashMap order is random per process; sorting makes the output the same on every miner
    let mut rows: Vec<_> = counts.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let mut out = io::stdout().lock();
    for (word, n) in rows {
        writeln!(out, "{n} {word}").unwrap();
    }
}
