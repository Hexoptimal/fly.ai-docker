// node --experimental-strip-types tools/probe.ts
// One fly: is it even flying? Prints the flight chain over time.
import { World } from "../src/sim.ts";
const world = new World(Number(process.argv[2] ?? 1));
const fly = world.flies[0];
fly.x = 0; fly.z = 10; fly.y = 2.2;
for (let i = 0; i <= 1000; i++) {
  world.step();
  if (i % 100) continue;
  const hz = (n: string) => ((world.rate(n, "L", fly) + world.rate(n, "R", fly)) / 2 * 50).toFixed(1);
  console.log(
    `t ${(i * 0.02).toFixed(1).padStart(5)}s  y ${fly.y.toFixed(2)}  v ${fly.speed.toFixed(2)}  landed ${fly.landed ? 1 : 0}  ` +
    `PVLP ${hz("PVLP")}  DNg100 ${hz("DNg100")}  VNC-IN ${hz("VNC-IN")}  IN19A ${hz("IN19A")}  DLM ${hz("DLM MN")}  ` +
    `b1 ${hz("b1 MN")}  lift ${(62 * (world.rate("DLM MN", "L", fly) + world.rate("DLM MN", "R", fly)) / 2).toFixed(2)}`);
}
