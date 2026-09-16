/**
 * Every WebAssembly example, run the way miners run it, with its answer checked: pi near 3.14, the hash search finding
 * Bitcoin's genesis nonce, a Mandelbrot tile with the set's edge in it, a valid shortest-of-several TSP tour, and word
 * counts. (matmul.wgsl needs a GPU; mine/src/programtest.ts and the browser tests cover shaders.)
 *
 *   node examples/test-examples.ts        (from mine/; `npm run test:examples`)
 */
import { readFileSync } from "node:fs";
import { inspectWasm } from "../src/wasmcheck.ts";
import { runWasm } from "../web/openjob.ts";
import { DIFF1, GENESIS, input as hashInput } from "./hash-search/make-inputs.ts";
import { stitch, TILE } from "./mandelbrot-tiles/stitch.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const here = (p: string) => readFileSync(new URL(p, import.meta.url));
const seed = new Uint8Array(32);
const index = (n: number) => new Uint8Array(new Uint32Array([n]).buffer);
const time = async <T>(fn: () => Promise<T>) => {
  const t = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t) };
};

for (const file of ["pi-rust/pi.wasm", "hash-search/hash_search.wasm", "mandelbrot-tiles/mandelbrot_tiles.wasm", "tsp-search/tsp_search.wasm", "wordcount-wasi/wordcount.wasm"]) {
  let ok = true;
  try { inspectWasm(here(file)); } catch { ok = false; }
  check(`${file} passes the miners' checks`, ok);
}

// pi: 20 count jobs
const PI = here("pi-rust/pi.wasm");
let hits = 0;
const pi = await time(async () => {
  for (let j = 0; j < 20; j++) hits += Number(new DataView((await runWasm(PI, index(j), seed, 64)).output.buffer).getBigUint64(0, true));
});
const estimate = (4 * hits) / (20 * 5_000_000);
check("pi: 20 jobs of 5M samples", Math.abs(estimate - Math.PI) < 0.002, `${estimate.toFixed(5)} in ${pi.ms} ms`);

// hash search: the genesis nonce is in the second of four ranges
const HASH = here("hash-search/hash_search.wasm");
const genesis = Buffer.from(GENESIS, "hex");
const found: number[] = [];
const search = await time(async () => {
  for (let j = 0; j < 4; j++) {
    const out = (await runWasm(HASH, hashInput(genesis, 2083236800 - 100 + j * 100, 100, Buffer.from(DIFF1, "hex")), seed, 1 << 16)).output;
    const n = new DataView(out.buffer).getUint32(0, true);
    for (let k = 0; k < n; k++) found.push(new DataView(out.buffer).getUint32(4 + k * 36, true));
    if (n) check("hash search: the winning hash is the genesis block's", Buffer.from(out.subarray(8, 40)).toString("hex") === "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f");
  }
});
check("hash search: 4 ranges of 100 nonces find Bitcoin's genesis nonce", found.length === 1 && found[0] === 2083236893, `${found.join(",")} in ${search.ms} ms`);

// mandelbrot: tile 27 (row 3, column 3) crosses the set's edge
const MANDEL = here("mandelbrot-tiles/mandelbrot_tiles.wasm");
const tile = await time(() => runWasm(MANDEL, index(27), seed, 1 << 20));
const counts = new Uint16Array(tile.value.output.buffer);
const inside = counts.filter((c) => c === 0).length;
check("mandelbrot: a 256 x 256 tile with inside and outside", counts.length === TILE * TILE && inside > 1000 && inside < counts.length - 1000, `${inside} inside, ${tile.ms} ms`);
const header = Buffer.byteLength(["P5", "2048 2048", "255", ""].join("\n"));
check("mandelbrot: stitch makes a 2048 x 2048 PGM", stitch((n) => (n === 27 ? tile.value.output : null)).length === header + 2048 * 2048);

// tsp: 8 restarts, each a valid tour, lengths vary, keep the best
const TSP = here("tsp-search/tsp_search.wasm");
const tours = await time(async () => Promise.all(Array.from({ length: 8 }, (_, j) => runWasm(TSP, index(j), seed, 1024))));
const lengths = tours.value.map((t) => new DataView(t.output.buffer).getUint32(0, true));
const valid = tours.value.every((t) => new Set(t.output.subarray(4)).size === 60 && t.output.length === 64);
check("tsp: 8 restarts give valid 60-city tours of different lengths", valid && new Set(lengths).size > 1, `best ${Math.min(...lengths)}, worst ${Math.max(...lengths)}, ${tours.ms} ms`);

const WC = here("wordcount-wasi/wordcount.wasm");
const wc = new TextDecoder().decode((await runWasm(WC, new TextEncoder().encode("a fly, a fly and a spider"), seed, 1 << 16)).output);
check("wordcount (WASI)", wc === "3 a\n2 fly\n1 and\n1 spider\n", JSON.stringify(wc));

console.log(failed ? `${failed} FAILED` : "example checks passed");
process.exit(failed ? 1 : 0);
