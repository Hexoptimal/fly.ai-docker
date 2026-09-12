// node --experimental-strip-types tools/assay.ts
// One fly, one fruit, one plume. Does the olfactory pathway actually steer?
// This is the controlled version of the crowded-world measurement.
import { EDGES, ORN_FOOD } from "../src/wiring.ts";
import { World } from "../src/sim.ts";

const START = 14; // metres downwind of the fruit

interface Run { arrived: number; closest: number; time: number; asym: number; orn: number }

function assay(label: string, opts: { wind?: number; trials?: number } = {}): Run {
  const wind = opts.wind ?? 1.2;
  const trials = opts.trials ?? 24;
  let arrived = 0, closest = 0, time = 0, asym = 0, orn = 0, samples = 0;
  for (let t = 0; t < trials; t++) {
    const world = new World(1);
    // keep the ring of rocks (it is what stops a fly leaving), drop the fruit
    const ring = world.props.filter((p) => p.kind === "obstacle" && Math.hypot(p.x, p.z) > 30);
    world.props.length = 0;
    world.props.push(...ring);
    world.props.push({
      id: 9001, kind: "fruit", x: 0, z: 0, y: 0.45, radius: 1.0,
      open: 1, height: 0.7, shape: 0.3, species: 0,
    });
    world.wind.strength = wind;
    world.wind.angle = 0; // air moves toward +Z, so downwind of the fruit is +Z
    const fly = world.flies[0];
    fly.x = (t % 5 - 2) * 1.5;
    fly.z = START;
    fly.y = 2.2;
    fly.yaw = (t / trials) * Math.PI * 2; // every starting heading
    let hit = -1;
    let best = 1e9;
    for (let i = 0; i < 3000; i++) {
      world.step();
      world.wind.angle = 0; // hold the wind steady for the assay
      const d = Math.hypot(fly.x, fly.z);
      if (d < best) best = d;
      if (hit < 0 && d < 2.0) hit = i;
      if (i % 10 === 0) {
        asym += Math.abs(world.rate("DNa02", "L", fly) - world.rate("DNa02", "R", fly));
        let o = 0;
        for (const k of Object.keys(fly.smell.drive)) o += (fly.smell.drive[k][0] + fly.smell.drive[k][1]) / 2;
        orn += o / 5;
        samples++;
      }
    }
    if (hit >= 0) { arrived++; time += hit * 0.02; }
    closest += best;
  }
  const r = { arrived: arrived / trials, closest: closest / trials, time: arrived ? time / arrived : NaN, asym: asym / samples, orn: orn / samples };
  console.log(
    `${label.padEnd(26)} reached fruit ${(r.arrived * 100).toFixed(0)}%  closest ${r.closest.toFixed(1)} m  ` +
    `t ${Number.isNaN(r.time) ? " -- " : r.time.toFixed(1) + " s"}  |DNa02 L-R| ${(r.asym * 50).toFixed(2)} Hz  ORN ${r.orn.toFixed(3)}`);
  return r;
}

const saved = EDGES.slice();
const cut = (...pairs: [string, string][]) => {
  EDGES.length = 0;
  EDGES.push(...saved.filter((e) => !pairs.some(([f, t]) => e.from === f && e.to === t)));
};
const restore = () => { EDGES.length = 0; EDGES.push(...saved); };

console.log(`start ${START} m downwind, fruit at the origin, 24 starting headings, 60 s each\n`);
assay("intact, wind 1.2");
cut(...ORN_FOOD.map((o) => [o, "lPN"] as [string, string]));
assay("no food ORN -> lPN");
restore();
cut(["JO", "WED"]);
assay("no JO -> WED");
restore();
assay("intact, wind 0 (no plume)", { wind: 0 });
cut(["LC10a", "PFL3"], ["LC10a", "LAL"]);
assay("no LC10a steering");
restore();
