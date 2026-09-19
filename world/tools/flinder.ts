/**
 * Flinder's readout, measured on the real connectome (the same files and engine the page runs). Each fly
 * swipes through random profiles on one brain, as on the page; prints pC1 counts and the right-swipe rate, and
 * how each trait moves pC1 on its own, so src/flinder/readout.ts can be checked.
 *   node --experimental-strip-types tools/flinder.ts [flies=8] [cards=12]
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ConnectomeBrain, cells, parseMeta, parseWeights } from "../src/connectome.ts";
import { READOUT, TRAITS, groups, runSwipe, type Traits } from "../src/flinder/readout.ts";

const dir = "public/connectome";
const unpack = (raw: Buffer) => { const b = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const parts: string[] = JSON.parse(readFileSync(`${dir}/brain.json`, "utf8")).parts;
const meta = parseMeta(unpack(readFileSync(`${dir}/meta.bin`)));
const w = parseWeights(unpack(Buffer.concat(parts.map((p) => readFileSync(`${dir}/${p}`)))));
const g = groups(meta, cells);
const FLIES = Number(process.argv[2] ?? 8), CARDS = Number(process.argv[3] ?? 12);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const zero = (): Traits => ({ musk: 0, moves: 0, snack: 0, scent: 0, song: 0 });

// each trait alone at 1, on fresh brains
const solo: Record<string, number[]> = {};
for (const k of ["none", ...TRAITS]) {
  solo[k] = [];
  for (let s = 0; s < 6; s++) {
    const t = zero(); if (k !== "none") t[k as keyof Traits] = 1;
    solo[k].push(runSwipe(new ConnectomeBrain(w, meta.params, 1 + s * 7919), g, t).heart);
  }
  console.log(`${k.padEnd(6)} pC1 ${solo[k].join(",")}`);
}

let rights = 0, total = 0;
const all: number[] = [];
for (let f = 0; f < FLIES; f++) {
  const b = new ConnectomeBrain(w, meta.params, 1 + f * 7919);
  const row: string[] = [];
  let r = 0;
  for (let c = 0; c < CARDS; c++) {
    const t = zero();
    for (const k of TRAITS) t[k] = rnd();
    const n = runSwipe(b, g, t);
    all.push(n.heart);
    row.push(`${n.heart}${n.choice === "right" ? "+" : ""}`);
    if (n.choice === "right") r++;
  }
  rights += r; total += CARDS;
  console.log(`fly ${f + 1}: right ${r}/${CARDS}  ${row.join(" ")}`);
}
all.sort((a, b) => a - b);
console.log(`right ${Math.round(100 * rights / total)}% at heart ${READOUT.heart}; pC1 p25 ${all[all.length >> 2]} median ${all[all.length >> 1]} p75 ${all[(3 * all.length) >> 2]}`);
