// where does hunger -> meal break? 24 flies, seed 1234 (the live world's), 230 s (before the first starvation at 240 s)
import { World, ECOLOGY } from "../src/sim.ts";
const w = new World(24, 1234);
const food = () => w.props.filter((p) => ECOLOGY[p.kind].food);
console.log("food props:", Object.entries(food().reduce((a, p) => ((a[p.kind] = (a[p.kind] ?? 0) + 1), a), {} as Record<string, number>)).map(([k, v]) => `${k} ${v}`).join(", "),
  "| non-food:", w.props.filter((p) => !ECOLOGY[p.kind].food).length);
const alt: number[] = [], altNear: number[] = [], nearH: number[] = [];
let samples = 0, nearFood = 0, nearLow = 0, landedGround = 0, landedFood = 0, landedOther = 0, feeding = 0, n = 0;
const everNear = new Set<number>(), everFed = new Set<number>();
let openSum = 0, openN = 0;
for (let i = 0; i < 230 * 50; i++) {
  w.step();
  if (i % 10) continue;
  const fs = food();
  for (const f of w.flies) {
    samples++;
    alt.push(f.y);
    const near = fs.find((p) => Math.hypot(f.x - p.x, f.z - p.z) < Math.max(1.3, p.radius * 1.3));
    if (near) { nearFood++; everNear.add(f.id); altNear.push(f.y - near.height); if (f.y < near.height + 1.0) nearLow++; }
    if (f.landed) { if (near && Math.abs(f.y - near.height) < 0.05) landedFood++; else if (f.y <= 0.45) landedGround++; else landedOther++; }
    if (f.feeding) { feeding++; everFed.add(f.id); }
  }
  for (const p of fs) { openSum += p.open; openN++; }
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))].toFixed(2) : "-"; };
const pc = (x: number) => (x / samples * 100).toFixed(1) + "%";
console.log(`altitude m: p10 ${q(alt, .1)} median ${q(alt, .5)} p90 ${q(alt, .9)}`);
console.log(`within landing pad of food: ${pc(nearFood)} of fly-samples; ${everNear.size}/24 flies ever; height above food there: p10 ${q(altNear, .1)} median ${q(altNear, .5)} p90 ${q(altNear, .9)}; low enough to land (<1 m above) ${pc(nearLow)}`);
console.log(`landed: on food ${pc(landedFood)}, on ground ${pc(landedGround)}, elsewhere ${pc(landedOther)}; feeding ${pc(feeding)}; flies that ever fed ${everFed.size}/24; landings ${w.landings}`);
console.log(`mean food 'open' ${(openSum / openN).toFixed(2)}; flies alive ${w.flies.length}`);
