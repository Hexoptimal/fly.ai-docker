/**
 * Check the browser connectome against the Python model (wiz/probe.py, flybrain FlyBrain with
 * sensory_input=False): speed, spikes per step at rest, and the looming -> DNp01 and
 * target -> DNa02 responses. Python reference: 7,731 fired/step at rest; loom L -> DNp01 L +18.6 Hz;
 * target L -> DNa02 L +3.0 Hz.
 *
 *   node --experimental-strip-types tools/connectome.ts [folder=public/connectome]
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ConnectomeBrain, cells, parseMeta, parseWeights } from "../src/connectome.ts";

const dir = process.argv[2] ?? "public/connectome";
const unpack = (raw: Buffer) => {
  const b = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const parts: string[] = JSON.parse(readFileSync(`${dir}/brain.json`, "utf8")).parts;

let t = performance.now();
const meta = parseMeta(unpack(readFileSync(`${dir}/meta.bin`)));
const w = parseWeights(unpack(Buffer.concat(parts.map((p) => readFileSync(`${dir}/${p}`)))));
console.log(`parsed ${w.n.toLocaleString()} neurons, ${w.nnz.toLocaleString()} synapses in ${((performance.now() - t) / 1000).toFixed(1)} s`);
console.log(`memory: ${((w.rowIdx.byteLength + w.colPtr.byteLength + w.code.byteLength) / 1e6).toFixed(0)} MB of weights`);

const STEPS = 50;
const rateOf = (brain: ConnectomeBrain, idx: Int32Array, steps: number, inject: [Int32Array, number][] = []) => {
  const mark = new Uint8Array(brain.n);
  for (const i of idx) mark[i] = 1;
  let spikes = 0, total = 0;
  for (let s = 0; s < steps; s++) {
    for (const [cellsIdx, amount] of inject) brain.stimulate(cellsIdx, amount);
    brain.step();
    total += brain.firedCount;
    for (let k = 0; k < brain.firedCount; k++) spikes += mark[brain.fired[k]];
  }
  return { hz: spikes / (idx.length * steps * meta.params.dt), firedPerStep: total / steps };
};

const trial = (label: string, reads: Int32Array, inject: [Int32Array, number][], seeds = 8) => {
  let delta = 0;
  for (let s = 0; s < seeds; s++) {
    const brain = new ConnectomeBrain(w, meta.params, 1000 + s);
    rateOf(brain, reads, STEPS);
    const before = rateOf(brain, reads, STEPS).hz;
    const after = rateOf(brain, reads, STEPS, inject).hz;
    delta += (after - before) / seeds;
  }
  console.log(`${label}: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} Hz`);
};

const brain = new ConnectomeBrain(w, meta.params, 7);
rateOf(brain, new Int32Array(0), STEPS);
t = performance.now();
const rest = rateOf(brain, new Int32Array(0), 200);
console.log(`rest: ${rest.firedPerStep.toFixed(0)} fired/step (${(rest.firedPerStep / w.n * 100).toFixed(2)}%), ` +
  `${((performance.now() - t) / 200).toFixed(2)} ms/step`);

trial("loom L -> DNp01 L", cells(meta, ["DNp01"], "L"), [[cells(meta, ["LPLC2"], "L"), 0.8]]);
trial("target L -> DNa02 L", cells(meta, ["DNa02"], "L"), [[cells(meta, ["LC10a"], "L"), 0.6]]);
