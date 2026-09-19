/**
 * Fly Roulette's rules are fair: with a stand-in brain (random choices, the same for every seat), each seat
 * should win 1/n of games. Checks game.ts for n = 2, 5 and 10 with a chi-square test, plus that every game
 * ends with exactly one winner and that one pair of seeds always plays the same game.
 *   node --experimental-strip-types tools/roulette-fair.ts [games=20000]
 */
import { deriveRng, playGame, setup } from "../src/roulette/game.ts";

const GAMES = Number(process.argv[2] ?? 20000);
// chi-square critical values at p = 0.001 for n-1 degrees of freedom
const CRIT: Record<number, number> = { 1: 10.83, 4: 18.47, 9: 27.88 };
let failed = 0;

for (const n of [2, 5, 10]) {
  const wins = new Array(n).fill(0);
  for (let g = 0; g < GAMES; g++) {
    const rng = await deriveRng(`server-${n}-${g}`, `client-${g}`);
    const table = setup(n, rng);
    let winner = -1, ends = 0;
    // stand-in brain: 25% of turns the fly flies off, whatever seat it's in
    for await (const e of playGame(table, rng, () => (Math.random() < 0.25 ? { wing: 30, grip: 90, gf: 5, choice: "fly" as const } : { wing: 10, grip: 100, gf: 5, choice: "pull" as const }))) {
      if (e.type === "end") { winner = e.winner; ends++; }
    }
    if (ends !== 1 || winner < 0 || winner >= n) { console.log(`n=${n} game ${g}: bad ending`); failed++; }
    wins[winner]++;
  }
  const expect = GAMES / n;
  const chi = wins.reduce((s, w) => s + (w - expect) ** 2 / expect, 0);
  const ok = chi < CRIT[n - 1];
  if (!ok) failed++;
  console.log(`${n} flies: wins per seat ${wins.join(" ")}  chi-square ${chi.toFixed(1)} (limit ${CRIT[n - 1]}) ${ok ? "fair" : "NOT FAIR"}`);
}

// the same seeds always give the same table and the same draws
const a = setup(5, await deriveRng("s", "c")), b = setup(5, await deriveRng("s", "c"));
const same = JSON.stringify(a) === JSON.stringify(b);
if (!same) failed++;
console.log(`same seeds, same table: ${same ? "yes" : "NO"}  (${a.names.join(", ")}; first ${a.first})`);
process.exit(failed ? 1 : 0);
