// node --experimental-strip-types tools/flight.ts
// Where do the flies spend their time, and do they keep feeding?
import { World } from "../src/sim.ts";
const world = new World(Number(process.argv[2] ?? 24));
function chance(): number {
  const fruit = world.props.filter((p) => p.kind === "fruit");
  let sum = 0;
  for (let i = 0; i < 4000; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 32;
    sum += Math.min(...fruit.map((f) => Math.hypot(Math.cos(a) * d - f.x, Math.sin(a) * d - f.z))) / 4000;
  }
  return sum;
}
console.log(`chance distance to nearest fruit: ${chance().toFixed(2)} m`);
world.wind.strength = Number(process.argv[3] ?? 0.8);
for (let i = 0; i < 12000; i++) {
  world.step();
  if (i % 2000) continue;
  const landed = world.flies.filter((b) => b.landed).length;
  const onFruit = world.flies.filter((b) => b.landed && world.props.some((p) => p.kind === "fruit" && Math.hypot(b.x - p.x, b.z - p.z) < 1.5)).length;
  const close = world.flies.filter((b) => Math.min(...world.props.filter((p) => p.kind === "fruit").map((f) => Math.hypot(b.x - f.x, b.z - f.z))) < 3).length;
  const feeding = world.flies.filter((b) => b.feeding).length;
  const alt = world.flies.reduce((s, b) => s + b.y, 0) / world.flies.length;
  const dlm = world.flies.reduce((s, b) => s + world.pair("DLM MN", b), 0) / world.flies.length * 50;
  const fruit = world.props.filter((p) => p.kind === "fruit");
  const near = world.flies.reduce((s, b) => s + Math.min(...fruit.map((f) => Math.hypot(b.x - f.x, b.z - f.z))), 0) / world.flies.length;
  const open = fruit.reduce((s, f) => s + f.open, 0) / fruit.length;
  console.log(`t ${(i * 0.02).toFixed(0).padStart(3)}s  alt ${alt.toFixed(2)}  landed ${landed}/${world.flies.length}  feeding ${feeding}  DLM ${dlm.toFixed(1)} Hz  nearest fruit ${near.toFixed(2)} m  fruit open ${(open * 100).toFixed(0)}%  landings ${world.landings}  feedsteps ${world.feedSteps}`);
}
