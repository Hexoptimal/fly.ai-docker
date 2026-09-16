// node --experimental-strip-types tools/memory.ts [code|learn|social|all] [--quick]
//
// The mushroom body, measured. Criteria were written here BEFORE the first run and are not tuned afterwards; every
// number is printed whether it passes or not.
//
// 1. code    Is the Kenyon-cell code sparse, and does it tell odours apart? One fly, held 1.5 m downwind of a single
//            source, three sources in turn (fruit esters, carrion amines, geosmin). A KC counts as active in a
//            0.2 s window if it fired at least once in it.
//            SPARSE: mean share of active KCs <= 0.35.
//            SEPARATES ODOURS: cosine similarity between two odours' mean KC vectors < 0.9x the split-half
//            similarity of one odour with itself (the ceiling this code can reach).
//
// Both behaviour tests use the same arena and the same score. Twelve flies, fermenting fruit at (-5, 0) and carrion
// at (+5, 0), the wind blowing toward +Z so each source trails a plume downwind of itself. One of the two is the
// PUNISHED source, swapped between seeds. A fly's preference index is
//     PI = (time within 3 m of the punished source - time within 3 m of the other) / time within 3 m of either,
// measured free-flying for 120 s before training and 120 s after it, and the score is dPI = after - before.
// During training flies are held in place (an experimenter's cage, nothing else): a held fly still sees, smells and
// spikes. The swatter is taken away before it can reach anyone, so the punishment is the sight of it and never a hit,
// and nobody starves during an assay.
//
// 2. learn   Does a punished odour become repellent to the fly that was punished? PAIRED: the flies are held 1.6 m
//            downwind of the punished source and the swatter looms beside them every 8 s. UNPAIRED: the same odour
//            for the same time and the same number of swatters, but never together -- 8 s in the plume, then 8 s in
//            clean air upwind with the swatter.
//            LEARNS: dPI(paired) - dPI(unpaired) <= -0.15 in at least 3 of 4 seeds. With the rule off it must NOT.
//
// 3. social  Can a fly learn from another fly's fright? Six DEMONSTRATORS are held 1.6 m downwind of the punished
//            source and the swatter looms beside them; six OBSERVERS are held in the same plume 4.4 m further
//            downwind, where what reaches them is the odour, the alarm CO2 a frightened fly gives off (sim.ts emits
//            it off DNp01) and a 2 m swatter seen from about 5 m away. Only the observers' dPI is scored.
//            SOCIAL LEARNING SHOWN: dPI(observers) - dPI(no demonstrators) <= -0.15 in at least 3 of 4 seeds.
//            VIA THE ALARM CO2: cutting DA2 PN -> PPL1-g2a1 removes at least half of that difference.
//            Controls: no demonstrators (the same holding, no swatter at all) and the memory rule off, and the
//            demonstrators' own dPI, which is test 2 run inside test 3.
// ROUND 2 (2026-09-16), set before running it: round 1 found (a) flies held 0.8 m apart see each other loom and
// frighten themselves, so every held fly gave off CO2 and taught itself; (b) the "toward" output was GABAergic onto
// the turn-away line, so punishment had nothing active to change. Changes, all found with held-fly diagnostics that
// are not these scores: cage spacing 1.6 m (giant fibre 0.53 -> 0.01 Hz with no swatter), observers held at 6 m
// downwind instead of 9 m (at 9 m the rock ring spooked them), the toward output is MBON-g2a'1 (cholinergic, taught by
// PPL1-g2a'1) onto forward flight and odour steering, the away output onto backing off and the steering veto, both
// resting near silent. Seeds are new (none used in any diagnostic). Thresholds are unchanged. Round 1 is in the README.
import { World, ECOLOGY, type Fly, type Prop } from "../src/sim.ts";
import { EDGES } from "../src/wiring.ts";
import type { Kind } from "../src/eyes.ts";
import { mulberry32 } from "../src/rng.ts";

const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith("--")) ?? "all";
const quick = args.includes("--quick");
// ROUND 3 (2026-09-16), set before running it: round 2 observers learned the same aversion with or without a
// frightened demonstrator (0.82 vs 0.80), because a crowd's stray CO2 kept the punishment teacher at 0.7 Hz and the rule
// had no threshold. Change: teachers write only in a burst (brain.ts MEMORY.burstHz = 5 Hz, from a rate diagnostic, not
// from these scores). New seeds; every threshold above unchanged. One criterion added, about the mechanism:
//   SELECTIVE: observers' learned aversion (toward - away depression) <= 0.2 with no demonstrators, AND with
//   demonstrators at least twice that.
// ROUND 4 (2026-09-16), set before running it: round 3's "no demonstrators" control had no swatter at
// all, so observers taught by the sight of the swatter looked social. The control is now the swatter coming down on the
// demonstrators' spot with the demonstrators held in clean air 9 m upwind; SOCIAL LEARNING SHOWN, VIA THE ALARM CO2 and
// SELECTIVE are measured against it. New seeds; every threshold unchanged. RUN: all three NOT met (README). (Planned with descending neurons at 2x tau,
// which was reverted before running: in the world no fly could land or feed. See the README.)
const SEEDS = quick ? [127, 131] : [127, 131, 137, 139];
const DT = 0.02;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const pm = (xs: number[], dp = 3) => `${mean(xs).toFixed(dp)} ± ${sd(xs).toFixed(dp)}`;
const results: Record<string, unknown> = {};

/** A small arena: the ring of rocks pulled in to 13 m, and whatever sources the test asks for. */
function arena(flies: number, seed: number, sources: [Kind, number, number][], learn = { hebbian: false, reward: false, mb: true }) {
  const world = new World(flies, seed, { genes: "fixed", learning: learn });
  const ring = world.props.filter((p) => p.kind === "obstacle" && Math.hypot(p.x, p.z) > 25);
  for (const r of ring) {
    const a = Math.atan2(r.z, r.x);
    r.x = Math.cos(a) * 13;
    r.z = Math.sin(a) * 13;
  }
  world.props.length = 0;
  world.props.push(...ring);
  sources.forEach(([kind, x, z], i) => {
    world.props.push({
      id: 9000 + i, kind, x, z, y: 0.45, radius: 1.0, open: 1, height: 0.7,
      shape: 0.3, species: 0, life: Infinity,
    } as Prop);
  });
  world.wind.strength = 1.2;
  world.wind.angle = 0; // the air moves toward +Z, so downwind of a source is +Z of it
  return world;
}

/** Hold the wind steady (the world turns it slowly and every phase should smell the same), and take the swatter away
 *  before it reaches the flies: the punishment in these tests is the sight of it, never being hit by it. */
function step(world: World): void {
  world.step();
  world.wind.angle = 0;
  if (world.threat && world.threat.y < 3.5) { world.threat = null; world.threatLife = 0; }
  // Nobody starves or ages in an assay. A fly dies of hunger after 240 s, founders start up to 180 s old with a 650 s
  // lifespan, and a trial runs 500 s: in the first full run (2026-09-16) every held fly died of old age before the test,
  // ageing had already turned their receptors down, and each corpse became a carrion odour source in the arena. That
  // run is void. What is measured here is where a fly chooses to be, not whether it can feed itself or outlive the test.
  for (const f of world.flies) { f.sinceFed = 0; f.age = 0; }
}

/** Bring the swatter down next to (x, z) rather than onto it: a fly there sees it loom and is not hit. */
function loom(world: World, x: number, z: number): void {
  world.threat = {
    id: 90000 + Math.round(world.time * 50), kind: "threat", x: x + 2.6, z, y: 22,
    radius: 2.0, open: 1, height: 5, shape: 0, species: 0, life: Infinity,
  } as Prop;
  world.threatLife = 1.6;
}

const saved = EDGES.slice();
const cut = (...pairs: [string, string][]) => {
  EDGES.length = 0;
  EDGES.push(...saved.filter((e) => !pairs.some(([f, t]) => e.from === f && e.to === t)));
};
const restore = () => { EDGES.length = 0; EDGES.push(...saved); };

// ============================================================================
// 1. the code
// ============================================================================
function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.max(1e-9, Math.sqrt(na) * Math.sqrt(nb));
}

/** Hold one fly in the plume and record which Kenyon cells fire, in 0.2 s windows. */
function kcCode(kind: Kind, seed: number): { share: number; halves: [Float64Array, Float64Array] } {
  const world = arena(1, seed, [[kind, 0, 0]]);
  const fly = world.flies[0];
  let sum: Float64Array | null = null;
  const halves: Float64Array[] = [];
  let windows = 0, active = 0;
  for (let phase = 0; phase < 2; phase++) {
    let half: Float64Array | null = null;
    let inHalf = 0;
    for (let w = 0; w < 150; w++) {
      let win: Float64Array | null = null;
      for (let i = 0; i < 10; i++) {
        fly.x = 0; fly.z = 1.5; fly.y = 1.2; fly.yaw = Math.PI; // facing the source, downwind of it
        fly.speed = 0; fly.vy = 0;
        step(world);
        const kc = fly.brain.kcActive();
        if (!win) win = new Float64Array(kc.length);
        for (let k = 0; k < kc.length; k++) if (kc[k]) win[k] = 1;
      }
      if (!win) continue;
      if (!sum) sum = new Float64Array(win.length);
      if (!half) half = new Float64Array(win.length);
      for (let k = 0; k < win.length; k++) { sum[k] += win[k]; half[k] += win[k]; active += win[k]; }
      windows++; inHalf++;
    }
    if (half) { for (let k = 0; k < half.length; k++) half[k] /= inHalf; halves.push(half); }
  }
  return { share: active / Math.max(1, windows * (sum?.length ?? 1)), halves: [halves[0], halves[1]] };
}

function sectionCode(): void {
  console.log("\n== 1. the Kenyon-cell code");
  const kinds: Kind[] = ["fruit", "carrion", "mould"];
  const shares: number[] = [];
  const within: number[] = [];
  const between: Record<string, number[]> = {};
  for (const seed of SEEDS) {
    const codes: Record<string, [Float64Array, Float64Array]> = {};
    for (const kind of kinds) {
      const c = kcCode(kind, seed);
      shares.push(c.share);
      within.push(cosine(c.halves[0], c.halves[1]));
      codes[kind] = c.halves;
    }
    const full = (k: string) => {
      const [a, b] = codes[k];
      const out = new Float64Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
      return out;
    };
    for (let i = 0; i < kinds.length; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        const key = `${kinds[i]} vs ${kinds[j]}`;
        (between[key] ??= []).push(cosine(full(kinds[i]), full(kinds[j])));
      }
    }
  }
  const ceiling = mean(within);
  console.log(`  active KCs per 0.2 s window ${pm(shares)}   (${ECOLOGY.fruit.label}, ${ECOLOGY.carrion.label}, ${ECOLOGY.mould.label})`);
  console.log(`  same odour, split half       ${pm(within)}  <- the ceiling`);
  const sims: number[] = [];
  for (const [key, xs] of Object.entries(between)) {
    console.log(`  ${key.padEnd(28)}${pm(xs)}`);
    sims.push(mean(xs));
  }
  const sparse = mean(shares) <= 0.35;
  const separates = Math.max(...sims) < 0.9 * ceiling;
  console.log(`  -> ${sparse ? "SPARSE" : "NOT SPARSE"}; ${separates ? "SEPARATES ODOURS" : "DOES NOT SEPARATE ODOURS"}`);
  results.code = { share: mean(shares), ceiling, between: Object.fromEntries(Object.entries(between).map(([k, v]) => [k, mean(v)])), sparse, separates };
}

// ============================================================================
// the shared arena: hold, punish, release, score
// ============================================================================
type Role = "punished" | "observer" | "held";

interface Group {
  flies: Fly[];
  role: Role;
  /** where they are held during training, relative to the punished source */
  at: [number, number];
}

const NEAR = 3;
/** spacing of held flies: at 0.8 m they loom at each other and frighten themselves (round 1) */
const CAGE = 1.6;

function preference(world: World, group: Fly[], bad: [number, number], good: [number, number], seconds: number): number {
  let nb = 0, ng = 0;
  for (let i = 0; i < seconds / DT; i++) {
    step(world);
    if (i % 5) continue;
    for (const f of group) {
      if (f.dead) continue;
      if (Math.hypot(f.x - bad[0], f.z - bad[1]) < NEAR) nb++;
      else if (Math.hypot(f.x - good[0], f.z - good[1]) < NEAR) ng++;
    }
  }
  return nb + ng === 0 ? 0 : (nb - ng) / (nb + ng);
}

function scatter(world: World, rand: () => number): void {
  for (const f of world.flies) {
    f.x = (rand() - 0.5) * 3;
    f.z = (rand() - 0.5) * 3;
    f.y = 1.5;
  }
}

interface Trial {
  /** dPI per group, keyed by role */
  dPI: Record<string, number>;
  teacher: Record<string, number>;
  co2: Record<string, number>;
  depth: Record<string, number>;
}

/**
 * One trial. `groups` says who is held where and who gets the swatter; `unpaired` alternates the odour and the
 * swatter instead of giving them together.
 */
function trial(seed: number, mb: boolean, build: (flies: Fly[], bad: [number, number]) => Group[], opts: { swatter: boolean; unpaired?: boolean; emptySpot?: boolean }): Trial {
  const rand = mulberry32(seed ^ 0x9e37);
  const flip = seed % 2 === 0;
  const bad: [number, number] = flip ? [5, 0] : [-5, 0];
  const good: [number, number] = flip ? [-5, 0] : [5, 0];
  const world = arena(12, seed, [["fruit", -5, 0], ["carrion", 5, 0]], { hebbian: false, reward: false, mb });
  const groups = build(world.flies, bad);
  scatter(world, rand);
  for (let i = 0; i < 60 / DT; i++) step(world); // settle
  const pre: Record<string, number> = {};
  for (const g of groups) pre[g.role] = preference(world, g.flies, bad, good, 120);

  const teacher: Record<string, number[]> = {}, co2: Record<string, number[]> = {};
  for (const g of groups) { teacher[g.role] = []; co2[g.role] = []; }
  let next = 0;
  for (let i = 0; i < 180 / DT; i++) {
    const t = i * DT;
    // unpaired: 8 s of odour with no swatter, then 8 s of clean air upwind with one
    const inPlume = !opts.unpaired || Math.floor(t / 8) % 2 === 0;
    for (const g of groups) {
      g.flies.forEach((f, k) => {
        if (f.dead) return;
        const [ox, oz] = inPlume ? g.at : [0, -9];
        f.x = bad[0] * (inPlume ? 1 : 0) + ox + (k % 3 - 1) * CAGE;
        f.z = bad[1] + oz + Math.floor(k / 3) * CAGE;
        f.y = 1.1; f.speed = 0; f.vy = 0;
      });
    }
    step(world);
    const punished = groups.find((g) => g.role === "punished");
    if (opts.swatter && punished && !inPlume === !!opts.unpaired && t > next && !world.threat && punished.flies[0]) {
      // emptySpot: the swatter comes down where the demonstrators would be held, with nobody there
      if (opts.emptySpot) loom(world, bad[0], bad[1] + 1.6);
      else loom(world, punished.flies[0].x, punished.flies[0].z);
      next = t + 8;
    }
    if (i % 25 === 0) {
      for (const g of groups) {
        const live = g.flies.filter((f) => !f.dead);
        teacher[g.role].push(mean(live.map((f) => world.pair("PPL1-g2a1", f) * 50)));
        co2[g.role].push(mean(live.map((f) => (f.smell.drive.Gr21a[0] + f.smell.drive.Gr21a[1]) / 2)));
      }
    }
  }
  world.threat = null;
  scatter(world, rand);
  for (let i = 0; i < 20 / DT; i++) step(world); // let the plume they were sitting in wash off the receptors
  const out: Trial = { dPI: {}, teacher: {}, co2: {}, depth: {} };
  for (const g of groups) {
    out.dPI[g.role] = preference(world, g.flies, bad, good, 120) - pre[g.role];
    out.teacher[g.role] = mean(teacher[g.role]);
    out.co2[g.role] = mean(co2[g.role]);
    out.depth[g.role] = mean(g.flies.filter((f) => !f.dead).map((f) => { const [t, a] = f.brain.memoryByCompartment(); return t - a; }));
  }
  return out;
}

/** Everyone is punished together: the direct-conditioning layout. */
const allPunished = (flies: Fly[]): Group[] => [{ flies: flies.slice(0, 6), role: "punished", at: [0, 1.6] }];
/** Demonstrators at the source, observers in the same plume 7.4 m further downwind. */
const withObservers = (flies: Fly[]): Group[] => [
  { flies: flies.slice(0, 6), role: "punished", at: [0, 1.6] },
  { flies: flies.slice(6), role: "observer", at: [0, 6] },
];
/** The round-4 control: the same observers, the demonstrators held in clean air 9 m upwind, the swatter on their empty spot. */
const withObserversEmpty = (flies: Fly[]): Group[] => [
  { flies: flies.slice(0, 6), role: "punished", at: [0, -9] },
  { flies: flies.slice(6), role: "observer", at: [0, 6] },
];

// ============================================================================
// 2. conditioning
// ============================================================================
function sectionLearn(): void {
  console.log("\n== 2. conditioning: does a punished odour become repellent?");
  const out: Record<string, { diff: number[]; paired: number[]; unpaired: number[]; depth: number[]; teacher: number[] }> = {};
  for (const mb of [true, false]) {
    const tag = mb ? "memory on" : "memory off";
    out[tag] = { diff: [], paired: [], unpaired: [], depth: [], teacher: [] };
    for (const seed of SEEDS) {
      const p = trial(seed, mb, allPunished, { swatter: true });
      const u = trial(seed, mb, allPunished, { swatter: true, unpaired: true });
      out[tag].paired.push(p.dPI.punished);
      out[tag].unpaired.push(u.dPI.punished);
      out[tag].diff.push(p.dPI.punished - u.dPI.punished);
      out[tag].depth.push(p.depth.punished);
      out[tag].teacher.push(p.teacher.punished);
    }
    const diff = out[tag].diff;
    const down = diff.filter((d) => d < 0).length;
    const passes = mean(diff) <= -0.15 && down >= Math.ceil(SEEDS.length * 0.75);
    console.log(`  ${tag.padEnd(11)} dPI paired ${pm(out[tag].paired)}  unpaired ${pm(out[tag].unpaired)}  ` +
      `difference ${pm(diff)} (${down}/${diff.length} seeds down)`);
    console.log(`              PPL1 while training ${mean(out[tag].teacher).toFixed(2)} Hz   learned aversion ${mean(out[tag].depth).toFixed(3)}`);
    console.log(`  -> ${tag}: ${passes ? "LEARNS" : "NO CLEAR EFFECT"}`);
    results[`learn_${mb ? "on" : "off"}`] = { diff: mean(diff), paired: mean(out[tag].paired), unpaired: mean(out[tag].unpaired), depth: mean(out[tag].depth), teacher: mean(out[tag].teacher), passes };
  }
}

// ============================================================================
// 3. learning from another fly
// ============================================================================
function sectionSocial(): void {
  console.log("\n== 3. learning from another fly's fright");
  const conditions: [string, { mb: boolean; swatter: boolean; empty?: boolean }, [string, string][]][] = [
    ["demonstrators", { mb: true, swatter: true }, []],
    ["swatter, empty spot", { mb: true, swatter: true, empty: true }, []],
    ["alarm CO2 route cut", { mb: true, swatter: true }, [["DA2 PN", "PPL1-g2a1"]]],
    ["memory rule off", { mb: false, swatter: true }, []],
  ];
  const obs: Record<string, number[]> = {};
  const demo: Record<string, number[]> = {};
  const extra: Record<string, { teacher: number[]; co2: number[]; depth: number[] }> = {};
  for (const [label, opts, cuts] of conditions) {
    if (cuts.length) cut(...cuts); else restore();
    obs[label] = []; demo[label] = [];
    extra[label] = { teacher: [], co2: [], depth: [] };
    for (const seed of SEEDS) {
      const r = trial(seed, opts.mb, opts.empty ? withObserversEmpty : withObservers, { swatter: opts.swatter, emptySpot: opts.empty });
      obs[label].push(r.dPI.observer);
      demo[label].push(r.dPI.punished);
      extra[label].teacher.push(r.teacher.observer);
      extra[label].co2.push(r.co2.observer);
      extra[label].depth.push(r.depth.observer);
    }
    restore();
    console.log(`  ${label.padEnd(20)} observers dPI ${pm(obs[label])}  demonstrators dPI ${pm(demo[label])}`);
    console.log(`  ${" ".repeat(20)} observer PPL1 ${mean(extra[label].teacher).toFixed(2)} Hz  CO2 drive ` +
      `${mean(extra[label].co2).toFixed(3)}  learned aversion ${mean(extra[label].depth).toFixed(3)}`);
  }
  const base = obs["swatter, empty spot"];
  const shift = obs["demonstrators"].map((d, i) => d - base[i]);
  const cutShift = obs["alarm CO2 route cut"].map((d, i) => d - base[i]);
  const offShift = obs["memory rule off"].map((d, i) => d - base[i]);
  const down = shift.filter((d) => d < 0).length;
  const shown = mean(shift) <= -0.15 && down >= Math.ceil(SEEDS.length * 0.75);
  const viaCo2 = shown && mean(cutShift) >= 0.5 * mean(shift);
  console.log(`  shift vs swatter on an empty spot ${pm(shift)} (${down}/${shift.length} seeds down)   ` +
    `CO2 route cut ${pm(cutShift)}   rule off ${pm(offShift)}`);
  console.log(`  -> ${shown ? "SOCIAL LEARNING SHOWN" : "SOCIAL LEARNING NOT SHOWN"}; ${viaCo2 ? "VIA THE ALARM CO2" : "ROUTE NOT SHOWN"}`);
  const aNone = mean(extra["swatter, empty spot"].depth), aDemo = mean(extra["demonstrators"].depth);
  const selective = aNone <= 0.2 && aDemo >= 2 * Math.max(aNone, 1e-9);
  console.log(`  learned aversion: demonstrators ${aDemo.toFixed(3)}  empty spot ${aNone.toFixed(3)}  -> ${selective ? "SELECTIVE" : "NOT SELECTIVE"}`);
  results.social = {
    observers: Object.fromEntries(Object.entries(obs).map(([k, v]) => [k, mean(v)])),
    demonstrators: Object.fromEntries(Object.entries(demo).map(([k, v]) => [k, mean(v)])),
    shift: mean(shift), cutShift: mean(cutShift), offShift: mean(offShift), shown, viaCo2,
  };
}

const t0 = Date.now();
if (which === "code" || which === "all") sectionCode();
if (which === "learn" || which === "all") sectionLearn();
if (which === "social" || which === "all") sectionSocial();
console.log(`\n${Math.round((Date.now() - t0) / 1000)} s`);
console.log("RESULTS", JSON.stringify(results));
