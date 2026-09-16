/**
 * Is the integer brain (src/fixed.ts) still the fly's brain? Runs the same jobs in the world's float engine
 * (world/src/connectome.ts) and in the mining engine, several seeds each, and compares what comes out.
 * The spike trains differ (different noise stream); the rates and the responses to the senses shouldn't.
 *
 *   npm run validate       ~5 minutes; exits 1 if the engines disagree beyond seed-to-seed noise
 */
import { fileURLToPath } from "node:url";
import { ConnectomeBrain } from "../../world/src/connectome.ts";
import { fixedFrom } from "./fixed.ts";
import { loadModel } from "./load.ts";
import type { Model } from "./model.ts";
import { drivenBy, runTask, type TaskParams } from "./runner.ts";

const dir = process.env.CONNECTOME_DIR ?? fileURLToPath(new URL("../../world/public/connectome/", import.meta.url));
const SEEDS = [1, 2, 3, 4];
const STEPS = 750;
const WARM = 250;

type Cond = Omit<TaskParams, "seed" | "steps" | "warm">;
const CONDITIONS: Cond[] = [
  { channel: "none", side: "L", amount: 0, gain: 3, tonic: 0.14 },
  { channel: "LPLC2", side: "L", amount: 0.4, gain: 3, tonic: 0.14 },
  { channel: "LC4", side: "R", amount: 0.8, gain: 3, tonic: 0.14 },
  { channel: "SNta", side: "L", amount: 0.4, gain: 3, tonic: 0.14 },
  { channel: "none", side: "L", amount: 0, gain: 2, tonic: 0.1 },
  { channel: "LC10a", side: "R", amount: 0.8, gain: 4, tonic: 0.18 },
];

interface Run { rate: number; base: number[]; stim: number[] }

function runFloat(model: Model, t: TaskParams): Run {
  const brain = new ConnectomeBrain(model.w, { ...model.meta.params, gain: t.gain, tonic: t.tonic }, t.seed);
  const idx = drivenBy(model, t);
  const G = model.outputs.length;
  const base = new Array(G).fill(0);
  const stim = new Array(G).fill(0);
  let spikes = 0;
  for (let s = 0; s < t.steps; s++) {
    const on = s >= t.warm;
    if (on) brain.stimulate(idx, t.amount);
    brain.step();
    spikes += brain.firedCount;
    for (let k = 0; k < brain.firedCount; k++) {
      const g = model.groupOf[brain.fired[k]];
      if (g >= 0) (on ? stim : base)[g]++;
    }
  }
  return toRates(model, t, spikes, base, stim);
}

function toRates(model: Model, t: TaskParams, spikes: number, base: number[], stim: number[]): Run {
  const dt = model.meta.params.dt;
  return {
    rate: spikes / model.w.n / (t.steps * dt),
    base: base.map((c, g) => c / model.outputSizes[g] / (t.warm * dt)),
    stim: stim.map((c, g) => c / model.outputSizes[g] / ((t.steps - t.warm) * dt)),
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / Math.max(1, xs.length - 1));
const f2 = (x: number) => x.toFixed(2);

const model = loadModel(dir);
const fx = fixedFrom(model.w.lut, model.meta.params);
const G = model.outputs.length;
let failed = 0;
// per condition, per group, per window: mean over seeds, and the float engine's seed spread
const pairs: { f: number; i: number; spread: number }[] = [];

console.log(`${SEEDS.length} seeds x ${CONDITIONS.length} conditions, ${STEPS * model.meta.params.dt} s each\n`);
console.log("condition                          population Hz: float        integer");
for (const c of CONDITIONS) {
  const fl: Run[] = [];
  const it: Run[] = [];
  for (const seed of SEEDS) {
    const t: TaskParams = { ...c, seed, steps: STEPS, warm: WARM };
    fl.push(runFloat(model, t));
    const r = runTask(model, fx, t);
    it.push(toRates(model, t, r.spikes, r.base, r.stim));
  }
  const name = `${c.channel === "none" ? "rest" : `${c.channel} ${c.side} ${c.amount}`} (gain ${c.gain}, tonic ${c.tonic})`;
  const fr = fl.map((r) => r.rate);
  const ir = it.map((r) => r.rate);
  const f3 = (x: number) => x.toFixed(3);
  console.log(`${name.padEnd(36)} ${f3(mean(fr))} ± ${f3(sd(fr))}   ${f3(mean(ir))} ± ${f3(sd(ir))}`);
  // 10% of the rate, but never finer than 0.05 Hz: a nearly silent brain (0.01 Hz) is all noise spikes
  const diff = Math.abs(mean(ir) - mean(fr));
  if (diff > Math.max(0.1 * mean(fr), 0.05)) {
    console.log(`  FAIL population rate differs by ${f3(diff)} Hz (${((100 * diff) / mean(fr)).toFixed(1)}%)`);
    failed++;
  }
  for (const win of ["base", "stim"] as const) {
    for (let g = 0; g < G; g++) {
      const fs = fl.map((r) => r[win][g]);
      pairs.push({ f: mean(fs), i: mean(it.map((r) => r[win][g])), spread: sd(fs) / Math.sqrt(SEEDS.length) });
    }
  }
  // the senses must still move the same outputs: the biggest driven changes in each engine
  if (c.channel !== "none") {
    const effect = (runs: Run[]) => Array.from({ length: G }, (_, g) => mean(runs.map((r) => r.stim[g] - r.base[g])));
    const ef = effect(fl);
    const ei = effect(it);
    const top = [...ef.keys()].sort((a, b) => Math.abs(ef[b]) - Math.abs(ef[a])).slice(0, 3);
    for (const g of top) console.log(`  ${model.outputs[g].padEnd(14)} driven change: float ${ef[g] >= 0 ? "+" : ""}${f2(ef[g])} Hz   integer ${ei[g] >= 0 ? "+" : ""}${f2(ei[g])} Hz`);
  }
}

// across every group, window and condition
const fs = pairs.map((p) => p.f);
const is = pairs.map((p) => p.i);
const mf = mean(fs);
const mi = mean(is);
const r = pairs.reduce((a, p) => a + (p.f - mf) * (p.i - mi), 0) / Math.sqrt(pairs.reduce((a, p) => a + (p.f - mf) ** 2, 0) * pairs.reduce((a, p) => a + (p.i - mi) ** 2, 0));
const within = pairs.filter((p) => Math.abs(p.i - p.f) <= 3 * Math.max(p.spread, 0.05)).length;
console.log(`\nmotor group rates, ${pairs.length} comparisons: correlation ${r.toFixed(3)}, ${within} within 3 standard errors of the float engine`);
if (r < 0.95) {
  console.log("FAIL correlation below 0.95");
  failed++;
}
if (within < pairs.length * 0.9) {
  console.log("FAIL fewer than 90% of rates within seed noise");
  failed++;
}
console.log(failed ? `${failed} check(s) failed` : "integer brain matches the float brain");
process.exit(failed ? 1 : 0);
