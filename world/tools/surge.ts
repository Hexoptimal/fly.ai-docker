// node --experimental-strip-types tools/surge.ts
// Does cast-and-surge emerge? Locks on to what a fly does in the second after a
// puff hits its antennae, versus when the plume has been lost.
import { World } from "../src/sim.ts";

const world = new World(Number(process.argv[2] ?? 16));
world.wind.strength = Number(process.argv[3] ?? 1.6);
for (let i = 0; i < 3000; i++) world.step();

interface Bin { n: number; speed: number; upwind: number; turn: number; dlm: number }
const bins: Bin[] = [];
for (let i = 0; i < 5; i++) bins.push({ n: 0, speed: 0, upwind: 0, turn: 0, dlm: 0 });
const EDGES = [0.25, 0.75, 1.5, 3.0, 1e9]; // seconds since the last odour hit

let hits = 0, samples = 0;
for (let i = 0; i < 9000; i++) {
  world.step();
  const [ux, uz] = world.windVector();
  const wlen = Math.max(1e-3, Math.hypot(ux, uz));
  for (const f of world.flies) {
    if (f.landed) continue;
    if (f.sinceHit === 0) hits++;
    samples++;
    const b = bins[EDGES.findIndex((e) => f.sinceHit <= e)];
    b.n++;
    b.speed += f.speed;
    b.upwind += -(Math.sin(f.yaw) * ux + Math.cos(f.yaw) * uz) / wlen;
    b.turn += Math.abs(f.motor.turn) * 50;
    b.dlm += world.pair("DLM MN", f) * 50;
  }
}
console.log(`wind ${world.wind.strength} m/s, ${world.flies.length} flies, ${world.field.puffCount} puffs live`);
console.log(`odour hits: ${hits} in ${samples} airborne fly-steps (${(hits / samples * 100).toFixed(2)}% of steps)`);
console.log("time since last odour hit | speed  upwind heading  |steering|  DLM");
const LABEL = ["< 0.25 s (a hit)", "0.25-0.75 s", "0.75-1.5 s", "1.5-3 s", "> 3 s (plume lost)"];
bins.forEach((b, i) => {
  if (!b.n) return;
  console.log(`  ${LABEL[i].padEnd(22)} ${(b.speed / b.n).toFixed(2)} m/s   ${(b.upwind / b.n).toFixed(3)}        ` +
    `${(b.turn / b.n).toFixed(2)}      ${(b.dlm / b.n).toFixed(1)} Hz   (n=${b.n})`);
});
