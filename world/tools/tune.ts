// Headless harness: node --experimental-strip-types tools/tune.ts [flies]
// Not part of the build; it exists so the network can be measured without a browser.
import { World } from "../src/sim.ts";

const n = Number(process.argv[2] ?? 40);
const world = new World(n);

function rates(): Map<string, number> {
  const out = new Map<string, number>();
  for (const fly of world.flies) {
    world.wiring.pops.forEach((p, i) => {
      const key = p.name + "_" + p.side;
      out.set(key, (out.get(key) ?? 0) + fly.brain.rate[i] / world.flies.length);
    });
  }
  return out;
}

const t0 = performance.now();
const STEPS = 2000; // 40 s
for (let i = 0; i < STEPS; i++) world.step();
const t1 = performance.now();

console.log(`neurons/fly ${world.wiring.n}  synapses ${world.wiring.nnz}  flies ${world.flies.length}`);
console.log(`sim: ${((t1 - t0) / STEPS).toFixed(3)} ms per 20 ms step (${((t1 - t0) / STEPS / 20 * 100).toFixed(1)}% of real time)`);

console.log("--- firing rates (Hz/neuron, mean over flies) ---");
const r = rates();
let line = "";
for (const spec of world.wiring.pops) {
  if (spec.side !== "L") continue;
  const v = (r.get(spec.name + "_L")! + r.get(spec.name + "_R")!) / 2;
  line += `${spec.name} ${v.toFixed(1)}`.padEnd(24);
  if (line.length > 90) { console.log("  " + line); line = ""; }
}
if (line) console.log("  " + line);

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`speed ${mean(world.flies.map((b) => b.speed)).toFixed(2)} m/s  altitude ${mean(world.flies.map((b) => b.y)).toFixed(2)} m  ` +
  `airborne ${(world.flies.filter((b) => !b.landed).length / world.flies.length * 100).toFixed(0)}%`);
console.log(`landings ${world.landings}  feeding steps ${world.feedSteps}  (${STEPS} steps, ${world.flies.length} flies)`);

const fruit = world.props.filter((p) => p.kind === "fruit");
const near = mean(world.flies.map((b) => Math.min(...fruit.map((f) => Math.hypot(b.x - f.x, b.z - f.z)))));
let chance = 0;
for (let i = 0; i < 500; i++) {
  const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 46;
  chance += Math.min(...fruit.map((f) => Math.hypot(Math.cos(a) * d - f.x, Math.sin(a) * d - f.z))) / 500;
}
console.log(`nearest fruit ${near.toFixed(2)} m (chance ${chance.toFixed(2)} m)`);

const before = rates();
world.dropThreat();
let dnp = 0, lc4 = 0, jumpMN = 0;
for (let i = 0; i < 150; i++) {
  world.step();
  const q = rates();
  dnp = Math.max(dnp, (q.get("DNp01_L")! + q.get("DNp01_R")!) / 2);
  lc4 = Math.max(lc4, (q.get("LC4_L")! + q.get("LC4_R")!) / 2);
  jumpMN = Math.max(jumpMN, (q.get("Ti extensor MN_L")! + q.get("Ti extensor MN_R")!) / 2);
}
console.log("--- threat dropped ---");
console.log(`  LC4 ${((before.get("LC4_L")! + before.get("LC4_R")!) / 2).toFixed(2)} -> ${lc4.toFixed(2)} Hz`);
console.log(`  DNp01 ${((before.get("DNp01_L")! + before.get("DNp01_R")!) / 2).toFixed(2)} -> ${dnp.toFixed(2)} Hz`);
console.log(`  Ti extensor MN ${((before.get("Ti extensor MN_L")! + before.get("Ti extensor MN_R")!) / 2).toFixed(2)} -> ${jumpMN.toFixed(2)} Hz`);
console.log(`  speed ${mean(world.flies.map((b) => b.speed)).toFixed(2)} m/s  altitude ${mean(world.flies.map((b) => b.y)).toFixed(2)} m`);
