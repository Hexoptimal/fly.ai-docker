// node --experimental-strip-types tools/motor.ts
// How the decoder's gains change what the flies actually do.
import { MOTOR, World } from "../src/sim.ts";

function trial(cruise: number, turn: number): string {
  MOTOR.cruise = cruise;
  MOTOR.turn = turn;
  MOTOR.back = cruise * 0.55;
  MOTOR.escape = cruise * 1.6;
  const world = new World(24);
  for (let i = 0; i < 1000; i++) world.step();
  const fruit = world.props.filter((p) => p.kind === "fruit");
  let near = 0, speed = 0, n = 0, close = 0;
  for (let i = 0; i < 1500; i++) {
    world.step();
    if (i % 25) continue;
    for (const b of world.flies) {
      near += Math.min(...fruit.map((f) => Math.hypot(b.x - f.x, b.z - f.z)));
      speed += b.speed;
      n++;
      for (const o of world.flies) {
        if (o !== b && Math.hypot(b.x - o.x, b.y - o.y, b.z - o.z) < 1.2) close++;
      }
    }
  }
  return `cruise ${cruise.toFixed(0).padStart(3)} turn ${turn.toFixed(1)} | speed ${(speed / n).toFixed(2)} | nearest fruit ${(near / n).toFixed(2)} | near-misses/fly-sample ${(close / n).toFixed(3)}`;
}

for (const c of [9, 14, 20, 26]) for (const t of [3.2, 6.0, 9.0]) console.log(trial(c, t));
