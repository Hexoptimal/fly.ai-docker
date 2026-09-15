// node --experimental-strip-types tools/lifedata.ts [learning|inheritance|groups|all] [--quick]
//
// The questions from the 2026-09-15 round, measured. Criteria were written here BEFORE the first run and are not
// tuned afterwards; every result is printed whether it passes or not.
//
// 1. learning     Do brains change, and does it help? Cohorts: frozen, hebbian, reward, both. Same world seed and the
//                 same founders per cohort (paired by seed), 24 flies, 60 s settle, 300 s measured, 4 seeds.
//                 CHANGES: mean synapse change of living flies at the end >= 1% (frozen must stay at 0).
//                 Feeding = seconds spent feeding per fly-second.
//                 HELPS: mean relative change vs frozen >= +10% AND at least 3 of 4 seeds higher.
//                 HURTS: mean relative change <= -10% AND at least 3 of 4 seeds lower. Otherwise NO CLEAR EFFECT.
//                 Deaths per 1000 fly-seconds are reported alongside, no criterion.
// 2. inheritance  Do children take after their parents? 36 flies, both learning rules on (the page's default),
//                 1500 s, 3 seeds, pooled. Child vs mean of its two parents, least squares, bootstrap 95% CI (2000).
//                 GENES (sanity, inherited by construction): slope within 0.7-1.3 with n >= 20.
//                 LIVED traits (meals per minute, age at death, brain change at death): RESEMBLE if n >= 20 and
//                 the CI lower bound > 0. Otherwise NO RESEMBLANCE SHOWN.
//                 Also reported, no criterion: generations reached, egg and larva fates, relationship labels.
// 3. groups       Do they gather, and is it the pheromone? 24 flies, 60 s settle, 300 s measured, 4 seeds,
//                 cVA 0.75 (normal) vs 0 (off). Nearest-neighbour ratio vs random placement (1 = random).
//                 GATHER: mean ratio < 0.9 in at least 3 of 4 seeds with cVA on.
//                 cVA DRIVES IT: ratio(on) < ratio(off) in at least 3 of 4 seeds AND mean difference <= -0.05.
//                 Share of grouped flies at food reported alongside (groups at food may be shared meals).
import { World } from "../src/sim.ts";
import { regression } from "../src/report.ts";
import type { Learning } from "../src/brain.ts";

const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith("--")) ?? "all";
const quick = args.includes("--quick");
const DT = 0.02;
const mean = (xs: number[]) => { const f = xs.filter(Number.isFinite); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN; };
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const pm = (xs: number[], dp = 3) => `${mean(xs).toFixed(dp)} ± ${sd(xs).toFixed(dp)}`;
const SEEDS = quick ? [11, 23] : [11, 23, 37, 51];
const results: Record<string, unknown> = {};

function run(world: World, settleS: number, measureS: number, each?: (w: World) => void) {
  for (let i = 0; i < settleS / DT; i++) world.step();
  const feed0 = world.feedSteps;
  const deaths0 = Object.values(world.deaths).reduce((a, b) => a + b, 0);
  let flySeconds = 0;
  for (let i = 0; i < measureS / DT; i++) {
    world.step();
    flySeconds += world.flies.length * DT;
    if (each && i % 50 === 0) each(world);
  }
  const deaths = Object.values(world.deaths).reduce((a, b) => a + b, 0) - deaths0;
  return {
    feeding: ((world.feedSteps - feed0) * DT) / Math.max(1e-9, flySeconds),
    deathsPer1000: (deaths * 1000) / Math.max(1e-9, flySeconds),
    drift: mean(world.flies.map((f) => f.brain.drift())),
  };
}

// ---------------------------------------------------------------------------------------------------------------
function learning(): void {
  const cohorts: Record<string, Learning> = {
    frozen: { hebbian: false, reward: false }, hebbian: { hebbian: true, reward: false },
    reward: { hebbian: false, reward: true }, both: { hebbian: true, reward: true },
  };
  const measure = quick ? 120 : 300;
  const out: Record<string, { feeding: number[]; deaths: number[]; drift: number[] }> = {};
  for (const [name, learn] of Object.entries(cohorts)) {
    out[name] = { feeding: [], deaths: [], drift: [] };
    for (const seed of SEEDS) {
      const r = run(new World(24, seed, { learning: learn }), 60, measure);
      out[name].feeding.push(r.feeding);
      out[name].deaths.push(r.deathsPer1000);
      out[name].drift.push(r.drift);
    }
    console.log(`${name.padEnd(8)} feeding ${pm(out[name].feeding, 4)} s/fly-s · deaths ${pm(out[name].deaths, 2)} /1000 fly-s · ` +
      `synapse change ${pm(out[name].drift.map((d) => d * 100), 2)}%`);
  }
  const verdicts: Record<string, unknown> = {};
  for (const name of ["hebbian", "reward", "both"]) {
    const rel = SEEDS.map((_, i) => out[name].feeding[i] / Math.max(1e-9, out.frozen.feeding[i]) - 1);
    const higher = rel.filter((r) => r > 0).length, lower = rel.filter((r) => r < 0).length;
    const need = Math.ceil(SEEDS.length * 0.75);
    const effect = mean(rel) >= 0.1 && higher >= need ? "HELPS" : mean(rel) <= -0.1 && lower >= need ? "HURTS" : "NO CLEAR EFFECT";
    const changes = mean(out[name].drift) >= 0.01 ? "CHANGES" : "DOES NOT CHANGE";
    verdicts[name] = { brain: changes, feeding: effect, relative_feeding: rel.map((r) => +r.toFixed(3)), seeds_higher: higher };
    console.log(`  ${name.padEnd(8)} brain ${changes} (mean ${(mean(out[name].drift) * 100).toFixed(2)}%) · feeding vs frozen ` +
      `${(mean(rel) * 100).toFixed(1)}% (${higher}/${SEEDS.length} seeds higher) -> ${effect}`);
  }
  console.log(`  frozen synapse change ${(mean(out.frozen.drift) * 100).toFixed(3)}% (must be 0)`);
  results.learning = { cohorts: out, verdicts };
}

// ---------------------------------------------------------------------------------------------------------------
function bootstrapSlope(points: [number, number][], n = 2000): [number, number] {
  let s = 12345;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const slopes: number[] = [];
  for (let k = 0; k < n; k++) {
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[Math.floor(rand() * points.length)];
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    const m = points.length;
    const den = sxx - (sx * sx) / m;
    if (den > 0) slopes.push((sxy - (sx * sy) / m) / den);
  }
  slopes.sort((a, b) => a - b);
  return [slopes[Math.floor(slopes.length * 0.025)], slopes[Math.floor(slopes.length * 0.975)]];
}

function inheritance(): void {
  const seconds = quick ? 600 : 1500;
  const seeds = quick ? [11] : [11, 23, 37];
  const pooled: Record<string, [number, number][]> = {};
  const genes = ["lifespan", "flight", "clutch", "gene_loom_escape", "gene_odour_steer", "olfaction_gain"];
  const lived = ["meals_per_min", "age_at_death", "final_drift"];
  const fates: Record<string, number> = {};
  const labels: Record<string, number> = {};
  let generations = 0, children = 0;
  for (const seed of seeds) {
    const w = new World(36, seed, { learning: { hebbian: true, reward: true } });
    for (let i = 0; i < seconds / DT; i++) w.step();
    const lin = [...w.log.lineage.values()];
    generations = Math.max(generations, ...lin.map((r) => Number(r.generation)));
    children += lin.filter((r) => r.mother !== null).length;
    for (const key of [...genes, ...lived]) (pooled[key] ??= []).push(...regression(w, key).points);
    for (const b of w.log.brood.values()) {
      const k = b.fate === "died" ? `died ${b.stage}: ${b.cause}` : String(b.fate);
      fates[k] = (fates[k] ?? 0) + 1;
    }
    for (const p of w.relationshipRows()) labels[String(p.label)] = (labels[String(p.label)] ?? 0) + 1;
    console.log(`seed ${seed}: ${lin.length} flies ever, ${lin.filter((r) => r.mother !== null).length} born, ` +
      `generation ${Math.max(...lin.map((r) => Number(r.generation)))}, adults at end ${w.flies.length}, matings ${w.matings}, eggs ${w.eggsLaid}, emerged ${w.emerged}`);
  }
  const verdicts: Record<string, unknown> = {};
  for (const key of [...genes, ...lived]) {
    const pts = pooled[key] ?? [];
    const n = pts.length;
    const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
    let sxy = 0, sxx = 0;
    for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    const slope = sxx ? sxy / sxx : NaN;
    const [lo, hi] = n >= 5 ? bootstrapSlope(pts) : [NaN, NaN];
    const isGene = genes.includes(key);
    const verdict = n < 20 ? "TOO FEW FAMILIES" : isGene
      ? (slope >= 0.7 && slope <= 1.3 ? "PASSES ON (sanity ok)" : "SANITY FAIL")
      : (lo > 0 ? "RESEMBLE" : "NO RESEMBLANCE SHOWN");
    verdicts[key] = { n, slope: +slope.toFixed(3), ci95: [+lo.toFixed(3), +hi.toFixed(3)], verdict };
    console.log(`  ${key.padEnd(18)} n ${String(n).padStart(3)} slope ${slope.toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}] -> ${verdict}`);
  }
  console.log("  egg and larva fates:", fates);
  console.log("  relationship labels (pairs ever):", labels);
  results.inheritance = { seconds, seeds, generations, children, verdicts, fates, labels };
}

// ---------------------------------------------------------------------------------------------------------------
function groups(): void {
  const measure = quick ? 120 : 300;
  const on: number[] = [], off: number[] = [], atFood: number[] = [], share: number[] = [];
  for (const seed of SEEDS) {
    for (const cva of [0.75, 0]) {
      const w = new World(24, seed);
      w.cvaStrength = cva;
      const ratios: number[] = [];
      run(w, 60, measure, (world) => {
        const r = world.log.world.rows.at(-1);
        if (!r) return;
        ratios.push(Number(r.aggregation));
        if (cva > 0) { atFood.push(Number(r.grouped_at_food)); share.push(Number(r.share_in_groups)); }
      });
      (cva > 0 ? on : off).push(mean(ratios));
    }
  }
  const need = Math.ceil(SEEDS.length * 0.75);
  const gather = on.filter((r) => r < 0.9).length >= need ? "GATHER" : "DO NOT CLEARLY GATHER";
  const diff = SEEDS.map((_, i) => on[i] - off[i]);
  const drives = diff.filter((d) => d < 0).length >= need && mean(diff) <= -0.05 ? "cVA DRIVES IT" : "cVA EFFECT NOT SHOWN";
  console.log(`nearest-neighbour ratio (1 = random): cVA on ${pm(on)} · cVA off ${pm(off)} · difference ${pm(diff)}`);
  console.log(`  share in groups (cVA on) ${pm(share, 2)} · of grouped flies at food ${pm(atFood, 2)}`);
  console.log(`  -> ${gather}; ${drives}`);
  results.groups = { on, off, diff, share_in_groups: mean(share), grouped_at_food: mean(atFood), gather, drives };
}

const t0 = performance.now();
if (which === "learning" || which === "all") { console.log("\n== 1. learning"); learning(); }
if (which === "inheritance" || which === "all") { console.log("\n== 2. inheritance"); inheritance(); }
if (which === "groups" || which === "all") { console.log("\n== 3. groups"); groups(); }
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s`);
console.log("RESULTS " + JSON.stringify(results));
