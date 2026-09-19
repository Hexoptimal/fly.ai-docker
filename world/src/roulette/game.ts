/**
 * Fly Roulette's rules, the one copy everything plays by: free play in the page, bet games on the server
 * (mine/src/roulette.worker.ts) and the page's Verify replay of a bet game.
 *
 * All chance comes from one generator seeded with sha256(serverSeed:clientSeed): each fly's brain seed (its
 * neural noise), the names at the table, who shoots first, and where the cap sits every time the drum is
 * loaded. Each fly's choice comes from its brain (`turn`, see readout.ts runTurn). Given the two seeds the
 * whole game is fixed, so a revealed server seed lets anyone replay it.
 *
 * Fairness: brain seeds are independent draws and the first shooter is a uniform seat, so seats are
 * interchangeable and each fly wins with probability 1/n whichever one a player backs. Every game has exactly
 * one winner, the last fly at the table.
 */
import type { Counts } from "./readout.ts";

export const MIN_FLIES = 2, MAX_FLIES = 10, CHAMBERS = 6;

export const NAMES = ["Buzzy", "Sir Buzzalot", "Lil' Wing", "Big Stinky", "Captain Compound", "Fruit Loop", "Zzzack",
  "Maggie Maggot", "Hoverboi", "Dr. Proboscis", "Six Legs Sally", "Banana Joe", "Swatless", "Wingston", "Larva Lou",
  "Count Buzzula", "Flyonce", "Tiny Rick", "Mr. Bristles", "Spud"];

/** sfc32: a small 128-bit-state generator, the same sequence in every JS engine (pure 32-bit integer math). */
export function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = c << 21 | c >>> 11;
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The game's generator from the two seeds (hex or any text). */
export async function deriveRng(serverSeed: string, clientSeed: string): Promise<() => number> {
  const h = await sha256Hex(`${serverSeed}:${clientSeed}`);
  const w = [0, 1, 2, 3].map((k) => parseInt(h.slice(k * 8, k * 8 + 8), 16));
  const rng = sfc32(w[0], w[1], w[2], w[3]);
  for (let k = 0; k < 12; k++) rng();              // mix the state before use
  return rng;
}

const int = (rng: () => number, n: number) => Math.floor(rng() * n);

export interface Table { names: string[]; seeds: number[]; first: number }

/** Who sits down: n distinct names, a brain seed each, and the first shooter. Draw order is part of the rules. */
export function setup(n: number, rng: () => number): Table {
  if (!Number.isInteger(n) || n < MIN_FLIES || n > MAX_FLIES) throw new Error(`a table seats ${MIN_FLIES} to ${MAX_FLIES} flies`);
  const pool = [...NAMES];
  const names: string[] = [];
  for (let i = 0; i < n; i++) names.push(pool.splice(int(rng, pool.length), 1)[0]);
  const seeds = names.map(() => Math.floor(rng() * 4294967296) >>> 0);
  return { names, seeds, first: int(rng, n) };
}

export type Outcome = "fly" | "click" | "bang";
export interface TurnEvent extends Counts {
  type: "turn";
  fly: number;
  /** empty clicks since the drum was loaded, when this turn began (the gun looms bigger with each) */
  chamber: number;
  choice: "fly" | "pull";
  outcome: Outcome;
  /** the drum was loaded again after this bang */
  reload: boolean;
}
export interface EndEvent { type: "end"; winner: number }
export type GameEvent = TurnEvent | EndEvent;

/**
 * Plays a table to the end. `turn` runs one fly's brain for one turn (it may be async: a worker, the server's
 * queue). Yields every turn, then the winner.
 */
export async function* playGame(table: Table, rng: () => number,
  turn: (fly: number, chamber: number) => Counts & { choice: "fly" | "pull" } | Promise<Counts & { choice: "fly" | "pull" }>,
): AsyncGenerator<GameEvent> {
  const n = table.seeds.length;
  const out = new Array<boolean>(n).fill(false);
  const alive = () => out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
  let cap = int(rng, CHAMBERS);
  let chamber = 0;
  let i = table.first;
  while (alive().length > 1) {
    const at = chamber;
    const c = await turn(i, at);
    let outcome: Outcome, reload = false;
    if (c.choice === "fly") {
      outcome = "fly";
      out[i] = true;
    } else if (chamber === cap) {
      outcome = "bang";
      out[i] = true;
      if (alive().length > 1) { cap = int(rng, CHAMBERS); chamber = 0; reload = true; }
    } else {
      outcome = "click";
      chamber++;
    }
    yield { type: "turn", fly: i, chamber: at, wing: c.wing, grip: c.grip, gf: c.gf, choice: c.choice, outcome, reload };
    const left = alive();
    if (left.length <= 1) break;
    i = left.find((j) => j > i) ?? left[0];
  }
  yield { type: "end", winner: alive()[0] };
}
