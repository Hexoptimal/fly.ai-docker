/**
 * A world job: one seeded run of the world simulation (world/src/sim.ts, the flies' own small brains, not the
 * connectome), summarized as JSON. The engine has no DOM and no Math.random, so the same seed gives the same run on
 * every miner's JavaScript engine; figures are rounded to 4 decimals all the same.
 */
import type { Learning } from "../../world/src/brain.ts";
import { World } from "../../world/src/sim.ts";

export interface WorldParams {
  seed: number;
  flies: number;
  seconds: number;
  genes: "vary" | "fixed";
  learning: Learning | null;
  /** seconds between population samples */
  sample_s: number;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function runWorld(p: WorldParams): Uint8Array {
  const world = new World(p.flies, p.seed, { genes: p.genes, ...(p.learning ? { learning: p.learning } : {}) });
  const steps = Math.round(p.seconds * 50);
  const every = Math.max(1, Math.round(p.sample_s * 50));
  const samples: { t: number; adults: number; larvae: number; feeding: number; landings: number; matings: number; eggs: number }[] = [];
  for (let s = 1; s <= steps; s++) {
    world.step();
    if (s % every === 0 || s === steps) {
      samples.push({
        t: r4(world.time), adults: world.flies.length, larvae: world.props.filter((x) => x.kind === "larva").length,
        feeding: world.feedSteps, landings: world.landings, matings: world.matings, eggs: world.eggsLaid,
      });
    }
  }
  const flies = world.flies.map((f) => ({ sex: f.sex, age: r4(f.age), meals: f.meals, matings: f.matings, rewards: r4(f.brain.rewards) }));
  const summary = {
    seed: p.seed, flies: p.flies, seconds: p.seconds, genes: p.genes, learning: p.learning,
    totals: {
      landings: world.landings, feed_steps: world.feedSteps, matings: world.matings, eggs: world.eggsLaid,
      hatched: world.hatched, emerged: world.emerged, deaths: { ...world.deaths }, brood_deaths: { ...world.broodDeaths },
    },
    end: {
      adults: flies.length, males: flies.filter((f) => f.sex === "M").length,
      mean_age: r4(flies.reduce((sum, f) => sum + f.age, 0) / Math.max(1, flies.length)),
      mean_meals: r4(flies.reduce((sum, f) => sum + f.meals, 0) / Math.max(1, flies.length)),
      larvae: world.props.filter((x) => x.kind === "larva").length,
    },
    samples,
    survivors: flies,
  };
  return new TextEncoder().encode(JSON.stringify(summary));
}
