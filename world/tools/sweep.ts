// node --experimental-strip-types tools/sweep.ts
// Sweeps the LIF parameters and reports resting descending-neuron rates,
// how close the flies end up to fruit, and the threat response.
import { ENCODER } from "../src/eyes.ts";
import { World } from "../src/sim.ts";

interface Result {
  gain: number; tonic: number; loomSize: number;
  dna: number; dnp: number; dng: number; mdn: number;
  fruit: number; chance: number; dnpPeak: number; speed: number;
}

function rate(world: World, name: string): number {
  const iL = world.wiring.pops.findIndex((p) => p.name === name && p.side === "L");
  const iR = world.wiring.pops.findIndex((p) => p.name === name && p.side === "R");
  let s = 0;
  for (const b of world.flies) s += (b.brain.rate[iL] + b.brain.rate[iR]) / 2;
  return s / world.flies.length;
}

function run(gain: number, tonic: number, loomSize: number): Result {
  ENCODER.loom_size = loomSize;
  const world = new World(24);
  world.params.gain = gain;
  world.params.tonic = tonic;
  for (let i = 0; i < 1000; i++) world.step();
  let fruit = 0, samples = 0, dna = 0, dnp = 0, dng = 0, mdn = 0, speed = 0;
  const fruit = world.props.filter((p) => p.kind === "fruit");
  for (let i = 0; i < 1000; i++) {
    world.step();
    if (i % 25 === 0) {
      for (const b of world.flies) {
        fruit += Math.min(...fruit.map((f) => Math.hypot(b.x - f.x, b.z - f.z)));
        speed += b.speed;
        samples++;
      }
      dna += rate(world, "DNa02"); dnp += rate(world, "DNp01");
      dng += rate(world, "DNg100"); mdn += rate(world, "MDN");
    }
  }
  const k = 1000 / 25;
  let chance = 0;
  for (let i = 0; i < 500; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 46;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    chance += Math.min(...fruit.map((f) => Math.hypot(x - f.x, z - f.z))) / 500;
  }
  world.dropThreat();
  let dnpPeak = 0;
  for (let i = 0; i < 150; i++) { world.step(); dnpPeak = Math.max(dnpPeak, rate(world, "DNp01")); }
  return {
    gain, tonic, loomSize,
    dna: dna / k, dnp: dnp / k, dng: dng / k, mdn: mdn / k,
    fruit: fruit / samples, chance, dnpPeak, speed: speed / samples,
  };
}

const gains = (process.env.GAINS ?? "0.5,0.8,1.2,1.8").split(",").map(Number);
const tonics = (process.env.TONICS ?? "0.05,0.09,0.14").split(",").map(Number);
const looms = (process.env.LOOMS ?? "0.15").split(",").map(Number);
console.log("gain tonic loomsz | DNa02 DNp01 DNg100  MDN | speed fruit (chance) | DNp01 peak");
for (const g of gains) for (const t of tonics) for (const l of looms) {
  const r = run(g, t, l);
  console.log(
    `${r.gain.toFixed(2)} ${r.tonic.toFixed(2)}  ${r.loomSize.toFixed(2)}  | ` +
    `${r.dna.toFixed(1).padStart(5)} ${r.dnp.toFixed(1).padStart(5)} ${r.dng.toFixed(1).padStart(6)} ${r.mdn.toFixed(1).padStart(4)} | ` +
    `${r.speed.toFixed(2).padStart(5)} ${r.fruit.toFixed(2).padStart(6)} (${r.chance.toFixed(2)}) | ${r.dnpPeak.toFixed(1)}`);
}
