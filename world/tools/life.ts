import { World } from "../src/sim.ts";
const w = new World(30);
for (let i = 0; i < 30000; i++) {
  w.step();
  if (i % 6000) continue;
  console.log(`t ${(i * 0.02).toFixed(0).padStart(4)}s  flies ${w.flies.length} (M ${w.flies.filter(f => f.sex === "M").length})  ` +
    `matings ${w.matings} eggs ${w.eggsLaid} hatched ${w.hatched}  ` +
    `deaths age ${w.deaths.age} starved ${w.deaths.starved} eaten ${w.deaths.eaten}  ` +
    `mean age ${(w.flies.reduce((s, f) => s + f.age, 0) / Math.max(1, w.flies.length)).toFixed(0)}s  ` +
    `larvae ${w.props.filter(p => p.kind === "larva").length}  carrion ${w.props.filter(p => p.kind === "carrion").length}`);
}
