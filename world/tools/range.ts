// node --experimental-strip-types tools/range.ts
// How far should a fruit be smellable? Sweeps the odour range.
import { SMELL } from "../src/senses.ts";
import { World } from "../src/sim.ts";

function run(falloff: number, plume: number, gain: number) {
  SMELL.falloff = falloff; SMELL.plume_length = plume; SMELL.odour_gain = gain;
  const world = new World(24);
  world.wind.strength = 0.5;
  for (let i = 0; i < 3000; i++) world.step();
  world.landings = 0; world.feedSteps = 0;
  const fruit = world.props.filter((p) => p.kind === "fruit");
  let near = 0, n = 0, orn = 0, close = 0;
  for (let i = 0; i < 7000; i++) {
    world.step();
    if (i % 25) continue;
    for (const b of world.flies) {
      const d = Math.min(...fruit.map((f) => Math.hypot(b.x - f.x, b.z - f.z)));
      near += d; if (d < 3) close++;
      let o = 0;
      for (const k of Object.keys(b.smell.drive)) o += (b.smell.drive[k][0] + b.smell.drive[k][1]) / 2;
      orn += o / 5; n++;
    }
  }
  console.log(`falloff ${falloff.toFixed(1)} plume ${plume.toFixed(0)} gain ${gain.toFixed(1)} | ORN ${(orn / n).toFixed(3)} | nearest ${(near / n).toFixed(2)} m | within 3 m ${(close / n * 100).toFixed(1)}% | landings ${world.landings} feedsteps ${world.feedSteps}`);
}
console.log("chance nearest-fruit distance for this field: 10.1 m");
for (const [f, p, g] of [[2.6, 7, 2.4], [5, 14, 2.4], [5, 14, 1.2], [9, 20, 1.2], [9, 20, 0.6]] as [number, number, number][]) run(f, p, g);
