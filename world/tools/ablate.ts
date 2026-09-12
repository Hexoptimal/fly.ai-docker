// node --experimental-strip-types tools/ablate.ts
// Cut one connection block out of the wiring and see what the flies lose.
// Everything reported in world/README.md comes from here.
import { EDGES, ORN_AVERSIVE, ORN_CVA, ORN_FOOD } from "../src/wiring.ts";
import { World } from "../src/sim.ts";

const FLIES = 24;
const WARMUP = 3000; // 60 s
const MEASURE = 5000; // 100 s

function measure(label: string, wind = 1.2): void {
  const world = new World(FLIES);
  world.wind.strength = wind;
  for (let i = 0; i < WARMUP; i++) world.step();
  world.landings = 0;
  world.feedSteps = 0;
  const good = world.props.filter((p) => p.kind === "fruit");
  const bad = world.props.filter((p) => p.kind === "mould");
  let n = 0, nearGood = 0, onGood = 0, onBad = 0, approach = 0, approachN = 0;
  let dlm = 0, tiext = 0, speed = 0, alt = 0, upwind = 0, moving = 0;

  for (let i = 0; i < MEASURE; i++) {
    world.step();
    if (i % 25) continue;
    const [ux, uz] = world.windVector();
    const wlen = Math.max(1e-3, Math.hypot(ux, uz));
    for (const f of world.flies) {
      const dg = Math.min(...good.map((p) => Math.hypot(f.x - p.x, f.z - p.z)));
      const db = Math.min(...bad.map((p) => Math.hypot(f.x - p.x, f.z - p.z)));
      nearGood += dg;
      if (dg < 2) onGood++;
      if (db < 2) onBad++;
      dlm += world.pair("DLM MN", f) * 50;
      tiext += world.pair("Ti extensor MN", f) * 50;
      speed += f.speed;
      alt += f.y;
      if (!f.landed && f.speed > 0.3) {
        upwind += -(Math.sin(f.yaw) * ux + Math.cos(f.yaw) * uz) / wlen;
        moving++;
        // speed-independent attraction measure: is it HEADING at its nearest
        // neighbour? +1 straight towards, -1 straight away, 0 for no preference.
        let best = 1e9, bx = 0, bz = 0;
        for (const o of world.flies) {
          if (o === f) continue;
          const d = Math.hypot(f.x - o.x, f.z - o.z);
          if (d < best) { best = d; bx = o.x - f.x; bz = o.z - f.z; }
        }
        if (best > 1.5 && best < 12) {
          approach += (Math.sin(f.yaw) * bx + Math.cos(f.yaw) * bz) / best;
          approachN++;
        }
      }
      n++;
    }
  }
  const ratio = onBad > 0 ? (onGood / onBad).toFixed(2) : "inf";
  console.log(
    `${label.padEnd(28)} fruit ${(nearGood / n).toFixed(2)} m  good/mould occupancy ${String(ratio).padStart(5)} ` +
    `(${(onGood / n * 100).toFixed(1)}% / ${(onBad / n * 100).toFixed(1)}%)  land ${String(world.landings).padStart(4)} ` +
    `feed ${String(world.feedSteps).padStart(5)}  toward-neighbour ${(approach / Math.max(1, approachN)).toFixed(3)}  ` +
    `DLM ${(dlm / n).toFixed(1)} TiExt ${(tiext / n).toFixed(1)}  v ${(speed / n).toFixed(2)} alt ${(alt / n).toFixed(2)} ` +
    `upwind ${(upwind / Math.max(1, moving)).toFixed(2)}`);
}

const saved = EDGES.slice();
const cut = (...pairs: [string, string][]) => {
  EDGES.length = 0;
  EDGES.push(...saved.filter((e) => !pairs.some(([f, t]) => e.from === f && e.to === t)));
};
const restore = () => { EDGES.length = 0; EDGES.push(...saved); };
const toPN = (types: string[], target: string) => types.map((o) => [o, target] as [string, string]);

console.log(`${FLIES} flies, 60 s warm-up then 100 s measured, wind 1.2 m/s.`);
measure("intact");
cut(...toPN(ORN_FOOD, "lPN")); measure("no food ORN -> lPN"); restore();
cut(...toPN(ORN_CVA, "lPN")); measure("no cVA ORN -> lPN"); restore();
cut(["Or56a", "DA2 PN"]); measure("no geosmin (Or56a -> DA2)"); restore();
cut(["Gr21a", "DA2 PN"]); measure("no CO2 (Gr21a -> V)"); restore();
cut(...toPN(ORN_AVERSIVE, "DA2 PN"), ["DA2 PN", "LH"]); measure("no aversive line at all"); restore();
cut(["LH", "LAL"], ["LH", "LPi"], ["LH", "MDN"]); measure("aversive PNs, no LH output"); restore();
cut(["JO", "WED"]); measure("no JO -> WED (airflow)"); restore();
cut(["SNta", "IN19A"], ["LB3", "IN19A"], ["LgLG", "IN19A"]); measure("no leg SN -> IN19A"); restore();
cut(["DNg100", "VNC-IN"], ["DNa02", "VNC-IN"], ["DNp01", "VNC-IN"], ["MDN", "VNC-IN"]);
measure("no DN -> VNC premotor"); restore();
cut(["LC10a", "PFL3"], ["LC10a", "LAL"]); measure("no LC10a -> steering"); restore();
cut(["VS", "DNg100"], ["VS", "PVLP"]); measure("no VS (ventral optic flow)"); restore();
console.log("--- wind 2.0 m/s: strong plumes ---");
measure("intact, wind 2.0", 2.0);
cut(...toPN(ORN_FOOD, "lPN")); measure("no food ORN, wind 2.0", 2.0); restore();
cut(["JO", "WED"]); measure("no JO -> WED, wind 2.0", 2.0); restore();
