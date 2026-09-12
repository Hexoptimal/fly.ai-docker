// node --experimental-strip-types tools/choice.ts
// A two-choice arena: one good fruit, one mouldy fruit, placed symmetrically.
// Does the geosmin pathway keep the flies off the mouldy one?
import { EDGES } from "../src/wiring.ts";
import { World } from "../src/sim.ts";

function arena(label: string, flip = false) {
  const world = new World(14);
  // a small arena: pull the ring of rocks in to 13 m so the flies stay in it
  const ring = world.props.filter((p) => p.kind === "obstacle" && Math.hypot(p.x, p.z) > 25);
  for (const r of ring) {
    const a = Math.atan2(r.z, r.x);
    r.x = Math.cos(a) * 13;
    r.z = Math.sin(a) * 13;
  }
  world.props.length = 0;
  world.props.push(...ring);
  const gx = flip ? 5 : -5;
  world.props.push({ id: 9001, kind: "fruit", x: gx, z: 0, y: 0.45, radius: 1.0, open: 1, height: 0.7, shape: 0.3, species: 0, life: Infinity });
  world.props.push({ id: 9002, kind: "mould", x: -gx, z: 0, y: 0.45, radius: 1.0, open: 1, height: 0.7, shape: 0.6, species: 0, life: Infinity });
  world.wind.strength = 1.2;
  for (const f of world.flies) { f.x = (Math.random() - 0.5) * 4; f.z = (Math.random() - 0.5) * 4; f.y = 1.5; }
  for (let i = 0; i < 2500; i++) world.step();

  let good = 0, bad = 0, n = 0, or56 = 0, food = 0, lh = 0;
  for (let i = 0; i < 7500; i++) {
    world.step();
    if (i % 10) continue;
    for (const f of world.flies) {
      if (Math.hypot(f.x - gx, f.z) < 2.5) good++;
      if (Math.hypot(f.x + gx, f.z) < 2.5) bad++;
      or56 += world.pair("Or56a", f) * 50;
      lh += world.pair("LH", f) * 50;
      food += world.pair("ORN_DM1", f) * 50;
      n++;
    }
  }
  console.log(`${label.padEnd(26)} near good ${(good / n * 100).toFixed(1)}%  near mould ${(bad / n * 100).toFixed(1)}%  ` +
    `ratio ${(good / Math.max(1, bad)).toFixed(2)}  Or56a ${(or56 / n).toFixed(2)} Hz  LH ${(lh / n).toFixed(2)} Hz  DM1 ${(food / n).toFixed(2)} Hz`);
  return good / Math.max(1, bad);
}

const saved = EDGES.slice();
const cut = (...pairs: [string, string][]) => {
  EDGES.length = 0;
  EDGES.push(...saved.filter((e) => !pairs.some(([f, t]) => e.from === f && e.to === t)));
};
const restore = () => { EDGES.length = 0; EDGES.push(...saved); };

console.log("14 flies, fruit and mould 10 m apart in a 13 m arena, 50 s settle + 150 s measured, wind 1.2");
arena("intact (good on left)");
arena("intact (sides swapped)", true);
cut(["Or56a", "DA2 PN"]);
arena("no geosmin -> DA2");
arena("no geosmin, swapped", true);
restore();
cut(["LH", "LAL"], ["LH", "LPi"], ["LH", "MDN"]);
arena("no LH output");
restore();
