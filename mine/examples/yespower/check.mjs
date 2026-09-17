// Runs the vector check (src/bin/vectors.rs) under node's WASI, since this machine has no native linker.
//   cargo build --release --target wasm32-wasip1 --bin vectors && node check.mjs
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";
const wasi = new WASI({ version: "preview1", args: ["vectors"], env: {}, stdio: "inherit" });
const wasm = await WebAssembly.compile(await readFile(new URL("./target/wasm32-wasip1/release/vectors.wasm", import.meta.url)));
const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject());
process.exitCode = wasi.start(instance) ?? 0;
