// node --experimental-strip-types tools/smell.ts
// Does olfaction actually find fruit? Sweeps the ORN encoder.
import { SMELL } from "../src/senses.ts";
import { World } from "../src/sim.ts";

function trial(gain: number, falloff: number, adapt: number) {
  SMELL.odour_gain = gain; SMELL.falloff = falloff; SMELL.adapt = adapt;
  const world = new World(24);
  for (let i = 0; i < 800; i++) world.step();
  world.landings = 0; world.feedSteps = 0;
  const fruit = world.props.filter((p) => p.kind === "fruit");
  let near = 0, n = 0, contrast = 0, orn = 0;
  for (let i = 0; i < 2000; i++) {
    world.step();
    if (i % 20) continue;
    for (const b of world.flies) {
      near += Math.min(...fruit.map((f) => Math.hypot(b.x - f.x, b.z - f.z)));
      let c = 0, tot = 0;
      for (const k of Object.keys(b.smell.drive)) {
        const [l, r] = b.smell.drive[k];
        c += Math.abs(l - r); tot += (l + r) / 2;
      }
      contrast += c / 5; orn += tot / 5; n++;
    }
  }
  return { gain, falloff, adapt, near: near / n, contrast: contrast / n, orn: orn / n, landings: world.landings, feed: world.feedSteps };
}

console.log("gain falloff adapt | ORN mean  |L-R| | nearest fruit | landings feeding");
for (const g of [1.2, 2.4, 4.0]) for (const f of [4.0]) for (const a of [0, 0.5]) {
  const r = trial(g, f, a);
  console.log(`${r.gain.toFixed(1)}  ${r.falloff.toFixed(1)}   ${r.adapt.toFixed(2)} | ${r.orn.toFixed(3)} ${r.contrast.toFixed(4)} | ${r.near.toFixed(2)} | ${r.landings} ${r.feed}`);
}
