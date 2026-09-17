# yespower: a CPU proof-of-work miner as a compute program

`yespower_search.wasm` searches a nonce range of a coin's block header with
[yespower](https://www.openwall.com/yespower/) 0.5 or 1.0, and reports the nonces whose hash met a target. The
[bridge](../yespower-pool) turns a mining pool's work into these jobs and submits the hits it finds.

This is a **pure-Rust port of the reference implementation** (`yespower-ref.c`, BSD-2-Clause, Solar Designer),
with its own SHA-256, HMAC and PBKDF2 and no dependencies, because the optimized C is hand-written SSE/AVX and
cannot be compiled to WebAssembly. All fourteen of the reference's published vectors match (see below).

yespower is deliberately CPU-friendly and GPU-hostile: 2 MB of scratchpad, random reads and 64-bit multiplies. That
is exactly why it survives in a browser, where RandomX does not - no runtime JIT and no 2 GB dataset are needed, so
WASM costs a few times over native instead of thirty.

## Input and output

| Bytes | Meaning |
|---|---|
| 0..76 | the header without its nonce, as the coin serializes it |
| 76..80 | first nonce, u32 LE |
| 80..84 | how many nonces to try, u32 LE |
| 84..116 | target, big-endian; a hash at or below it is a hit |
| 116 | version: 0 for yespower 0.5, 1 for yespower 1.0 |
| 117..121 | N, u32 LE (a power of two, 1024..524288) |
| 121..125 | r, u32 LE (8..32) |
| 125 | length of the personalization string, then its bytes |

Output: u32 LE number of hits (at most 16), then for each a u32 LE nonce and its 32-byte hash.

## Building and checking

```
cargo build --release --target wasm32-unknown-unknown      # the program miners run
cp target/wasm32-unknown-unknown/release/yespower_search.wasm .

cargo build --release --target wasm32-wasip1 --bin vectors # the vector check
node check.mjs                                             # runs it under node's WASI
node rate.mjs                                              # hashrate per parameter set, in the job sandbox
```

The vector check runs as WASI rather than a native `cargo test` because this project's Windows machine has no MSVC
linker; it also proves the code works in the same sandbox miners use.

Measured with `rate.mjs`, single thread: 243 H/s at yescrypt's parameters (N=2048, r=8, version 0.5), 329 H/s for
yespower 1.0 at r=8, and about 85 H/s for the r=16 and r=32 sets.
