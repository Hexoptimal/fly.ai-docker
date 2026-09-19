/**
 * Fly Roulette's readout, measured on the real connectome (the same files and engine the page runs).
 * Each turn the toy gun looms at the fly (LPLC2 + LC4, stronger with every empty chamber) while its front
 * legs touch the trigger (SNta). Over a 0.6 s window we count wing-power motor neuron spikes (take-off) and
 * leg flexor spikes (the squeeze). Prints both per loom level, over many flies, so the page's constants
 * (src/roulette/readout.ts) can be checked.
 *   node --experimental-strip-types tools/roulette.ts [seeds=24]
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ConnectomeBrain, cells, parseMeta, parseWeights } from "../src/connectome.ts";
import { READOUT, groups, loomFor, decide } from "../src/roulette/readout.ts";

const dir = "public/connectome";
const unpack = (raw: Buffer) => { const b = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const parts: string[] = JSON.parse(readFileSync(`${dir}/brain.json`, "utf8")).parts;
const meta = parseMeta(unpack(readFileSync(`${dir}/meta.bin`)));
const w = parseWeights(unpack(Buffer.concat(parts.map((p) => readFileSync(`${dir}/${p}`)))));
const g = groups(meta, cells);
const SEEDS = Number(process.argv[2] ?? 24);

for (let chamber = 0; chamber < 6; chamber++) {
  const wing: number[] = [], grip: number[] = [], gf: number[] = [];
  let bails = 0;
  for (let s = 0; s < SEEDS; s++) {
    const b = new ConnectomeBrain(w, meta.params, 1 + s * 7919);
    for (let k = 0; k < READOUT.warmSteps; k++) b.step();
    const n = { wing: 0, grip: 0, gf: 0 };
    for (let k = 0; k < READOUT.windowSteps; k++) {
      b.stimulate(g.loom, loomFor(chamber)); b.stimulate(g.touch, READOUT.touch); b.step();
      for (let q = 0; q < b.firedCount; q++) { const i = b.fired[q]; n.wing += g.isWing[i]; n.grip += g.isGrip[i]; n.gf += g.isGf[i]; }
    }
    wing.push(n.wing); grip.push(n.grip); gf.push(n.gf);
    if (decide(n) === "fly") bails++;
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  console.log(`chamber ${chamber + 1} loom ${loomFor(chamber).toFixed(3)}: bail ${Math.round(100 * bails / SEEDS)}%  ` +
    `wing ${Math.min(...wing)}-${Math.max(...wing)} (med ${med(wing)})  grip med ${med(grip)}  giant fibre med ${med(gf)}`);
}
