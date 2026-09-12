// node --experimental-strip-types tools/lifeab.ts
// The life-cycle round shipped without ablations. This is the missing table:
// does the giant fibre keep flies off the spiders, does the courtship circuit
// actually produce the matings, and does the lateral horn keep eggs off mould?
//
// Every number here is a population statistic over several seeds, because the
// life cycle is far noisier than the foraging measurements in ablate.ts: a
// single lucky mating early on changes the whole population trace.
import { EDGES } from "../src/wiring.ts";
import { World } from "../src/sim.ts";

const saved = EDGES.slice();
const cut = (...pairs: [string, string][]) => {
  EDGES.length = 0;
  EDGES.push(...saved.filter((e) => !pairs.some(([f, t]) => e.from === f && e.to === t)));
};
const restore = () => { EDGES.length = 0; EDGES.push(...saved); };

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const pm = (xs: number[], dp = 2) => `${mean(xs).toFixed(dp)}±${sd(xs).toFixed(dp)}`;

// ---------------------------------------------------------------------------
// 1. Predation. Spiders rear up (a real loom) and eat anything still on the
//    ground when they strike. Deaths are reported per 1,000 fly-seconds so a
//    run that loses flies early is not scored as safer than one that does not.
// ---------------------------------------------------------------------------
function predation(label: string, seeds = 4): void {
  const eaten: number[] = [], other: number[] = [], esc: number[] = [], ground: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const world = new World(24, 1234 + s * 101);
    for (let i = 0; i < 1500; i++) world.step(); // 30 s settle
    world.deaths.eaten = 0; world.deaths.age = 0; world.deaths.starved = 0;
    let flySeconds = 0, dnp = 0, n = 0, low = 0;
    for (let i = 0; i < 12500; i++) { // 250 s
      world.step();
      flySeconds += world.flies.length * 0.02;
      if (i % 25) continue;
      for (const f of world.flies) {
        dnp += world.pair("DNp01", f) * 50;
        if (f.y < 0.85) low++;
        n++;
      }
    }
    const k = 1000 / Math.max(1, flySeconds);
    eaten.push(world.deaths.eaten * k);
    other.push((world.deaths.age + world.deaths.starved) * k);
    esc.push(dnp / Math.max(1, n));
    ground.push((low / Math.max(1, n)) * 100);
  }
  console.log(`${label.padEnd(30)} eaten ${pm(eaten)} /1000 fly-s   other deaths ${pm(other)}   ` +
    `DNp01 ${pm(esc)} Hz   on/near ground ${pm(ground, 1)}%`);
}

// ---------------------------------------------------------------------------
// 2. Courtship. P1 is driven by Gr68a (foreleg contact) and LC10a (the visual
//    target tracker), and shut down by AL-LN carrying a mated female's cVA.
//    Mating itself is a world rule reading P1, so this measures the drive.
// ---------------------------------------------------------------------------
function courtship(label: string, seeds = 4): void {
  const mat: number[] = [], p1: number[] = [], song: number[] = [], eggs: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const world = new World(24, 1234 + s * 101);
    for (let i = 0; i < 2500; i++) world.step(); // 50 s: females reach maturity at 40 s
    world.matings = 0; world.eggsLaid = 0;
    let p = 0, sg = 0, n = 0;
    for (let i = 0; i < 12500; i++) { // 250 s
      world.step();
      if (i % 25) continue;
      for (const f of world.flies) {
        if (f.sex !== "M") continue;
        p += world.pair("P1", f) * 50;
        sg += world.pair("pIP10", f) * 50;
        n++;
      }
    }
    mat.push(world.matings);
    eggs.push(world.eggsLaid);
    p1.push(p / Math.max(1, n));
    song.push(sg / Math.max(1, n));
  }
  console.log(`${label.padEnd(30)} matings ${pm(mat, 1)}   eggs ${pm(eggs, 1)}   ` +
    `P1 (males) ${pm(p1)} Hz   pIP10 ${pm(song)} Hz`);
}

// ---------------------------------------------------------------------------
// 3. Egg-laying substrate. A two-patch arena: one good fruit, one mouldy, both
//    reachable. Eggs are placed where the female stands, so counting eggs by
//    the patch they sit on is a direct read of `LB3 - LH` choosing a substrate.
//    Sides are swapped between runs because ablate.ts found the side-swap
//    variance larger than any geosmin effect in the open world.
// ---------------------------------------------------------------------------
function substrate(label: string, seeds = 4): void {
  const good: number[] = [], bad: number[] = [], lb3: number[] = [], lh: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const flip = s % 2 === 1;
    const world = new World(20, 1234 + s * 101);
    const ring = world.props.filter((p) => p.kind === "obstacle" && Math.hypot(p.x, p.z) > 25);
    for (const r of ring) {
      const a = Math.atan2(r.z, r.x);
      r.x = Math.cos(a) * 13;
      r.z = Math.sin(a) * 13;
    }
    world.props.length = 0;
    world.props.push(...ring);
    const gx = flip ? 4 : -4;
    world.props.push({ id: 9001, kind: "fruit", x: gx, z: 0, y: 0.45, radius: 1.4, open: 1, height: 0.7, shape: 0.3, species: 0, life: Infinity });
    world.props.push({ id: 9002, kind: "mould", x: -gx, z: 0, y: 0.45, radius: 1.4, open: 1, height: 0.7, shape: 0.6, species: 0, life: Infinity });
    for (let i = 0; i < world.flies.length; i++) {
      const f = world.flies[i], a = (i / world.flies.length) * Math.PI * 2;
      f.x = Math.cos(a) * 2; f.z = Math.sin(a) * 2; f.y = 1.5;
    }
    for (let i = 0; i < 2500; i++) world.step();

    let l = 0, h = 0, n = 0;
    for (let i = 0; i < 15000; i++) { // 300 s
      world.step();
      if (i % 25) continue;
      for (const f of world.flies) {
        if (f.sex !== "F") continue;
        l += world.pair("LB3", f) * 50;
        h += world.pair("LH", f) * 50;
        n++;
      }
    }
    // eggs and larvae still sitting on each patch
    let g = 0, b = 0;
    for (const p of world.props) {
      if (p.kind !== "egg" && p.kind !== "larva") continue;
      if (Math.hypot(p.x - gx, p.z) < 2) g++;
      if (Math.hypot(p.x + gx, p.z) < 2) b++;
    }
    good.push(g); bad.push(b);
    lb3.push(l / Math.max(1, n)); lh.push(h / Math.max(1, n));
  }
  const ratio = mean(good) / Math.max(0.5, mean(bad));
  console.log(`${label.padEnd(30)} on fruit ${pm(good, 1)}   on mould ${pm(bad, 1)}   ` +
    `ratio ${ratio.toFixed(2)}   LB3 ${pm(lb3)} Hz   LH ${pm(lh)} Hz`);
}

console.log("--- 1. predation: 24 flies, 30 s settle + 250 s, 4 seeds -------------------");
predation("intact");
cut(["LPLC2", "DNp01"], ["LC4", "DNp01"]);
predation("no loom -> DNp01"); restore();
cut(["DNp01", "Ti extensor MN"], ["DNp01", "Sternotrochanter MN"], ["DNp01", "VNC-IN"]);
predation("no DNp01 -> jump muscles"); restore();

console.log("\n--- 2. courtship: 24 flies, 50 s settle + 250 s, 4 seeds ------------------");
courtship("intact");
cut(["LC10a", "P1"]);
courtship("no LC10a -> P1 (vision)"); restore();
cut(["Gr68a", "P1"]);
courtship("no Gr68a -> P1 (contact)"); restore();
cut(["AL-LN", "P1"]);
courtship("no AL-LN -| P1 (cVA veto)"); restore();

console.log("\n--- 3. egg substrate: 20 flies, fruit vs mould 8 m apart, 300 s, 4 seeds --");
substrate("intact");
cut(["Or56a", "DA2 PN"]);
substrate("no geosmin -> DA2"); restore();
cut(["LH", "LAL"], ["LH", "LPi"], ["LH", "MDN"]);
substrate("no LH output (steering)"); restore();
