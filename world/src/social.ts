/**
 * Who spends time with whom, and whether flies gather. Measurement only: nothing here feeds back into a brain.
 *
 * Per pair of flies (while both are alive):
 *   near        seconds within NEAR_M of each other
 *   bumps       mid-air collisions (both tumble)
 *   startles    one fly's giant fibre fired (escape onset) while the other was the nearest fly closing in on it
 *               (within STARTLE_M, closing faster than STARTLE_CLOSING m/s). First version blamed every fly within
 *               2 m: on 36 flies, seed 7, 900 s, enemy pairs averaged 7.1 startles against 0.46 bumps after only
 *               22 s together, so "enemies" were flies near a spontaneous escape, not flies scaring each other.
 *   courtships  seconds a male's P1 was above the mating threshold within 0.8 m of the female
 *   matings     matings between the two
 *
 * Labels, first match wins, thresholds fixed before any run (2026-09-15):
 *   mates          matings > 0
 *   family         parent and child, or same mother
 *   enemies        tension >= 6 and at least one tension event per 20 s spent near (tension = bumps + 2 x startles)
 *   friends        near >= 90 s and at most one tension event per 60 s near
 *   acquaintances  near >= 20 s
 *
 * Groups: single-linkage clusters of flies closer than GROUP_M (3-D), 3 or more flies. Aggregation: the Clark-Evans
 * ratio of the mean nearest-neighbour distance (on the ground plane) to what the same number of flies placed at
 * random in the same arena would give (Monte Carlo, so the arena edge is in both). Below 1 = gathered, 1 = random.
 */
export const NEAR_M = 1.5;
export const STARTLE_M = 2.0;
export const STARTLE_CLOSING = 0.5;
export const GROUP_M = 2.0;
export const LABELS = ["mates", "family", "enemies", "friends", "acquaintances"] as const;
export type Label = (typeof LABELS)[number] | "";

export interface PairStats {
  a: number;
  b: number;
  near: number;
  bumps: number;
  startles: number;
  courtships: number;
  matings: number;
  /** world step of the last step the two were touching mid-air, so one collision counts once */
  lastBump: number;
}

export interface Kin { id: number; mother: number | null; father: number | null }

export class Social {
  readonly pairs = new Map<string, PairStats>();

  private key(a: number, b: number): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  get(a: number, b: number): PairStats {
    const k = this.key(a, b);
    let p = this.pairs.get(k);
    if (!p) {
      p = { a: Math.min(a, b), b: Math.max(a, b), near: 0, bumps: 0, startles: 0, courtships: 0, matings: 0, lastBump: -10 };
      this.pairs.set(k, p);
    }
    return p;
  }

  static tension(p: PairStats): number {
    return p.bumps + 2 * p.startles;
  }

  static label(p: PairStats, family: boolean): Label {
    const t = Social.tension(p);
    if (p.matings > 0) return "mates";
    if (family) return "family";
    if (t >= 6 && t >= p.near / 20) return "enemies";
    if (p.near >= 90 && t <= p.near / 60) return "friends";
    if (p.near >= 20) return "acquaintances";
    return "";
  }

  static isFamily(x: Kin | undefined, y: Kin | undefined): boolean {
    if (!x || !y) return false;
    if (x.mother === y.id || x.father === y.id || y.mother === x.id || y.father === x.id) return true;
    return x.mother !== null && x.mother === y.mother;
  }
}

export interface GroupStats {
  groupOf: Int32Array;
  sizes: number[];
  inGroups: number;
  largest: number;
}

/** Single-linkage clusters within GROUP_M; groups are 3 or more flies. */
export function findGroups(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>): GroupStats {
  const n = xs.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const r2 = GROUP_M * GROUP_M;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[i] - xs[j], dy = ys[i] - ys[j], dz = zs[i] - zs[j];
      if (dx * dx + dy * dy + dz * dz <= r2) parent[find(i)] = find(j);
    }
  }
  const count = new Map<number, number>();
  for (let i = 0; i < n; i++) count.set(find(i), (count.get(find(i)) ?? 0) + 1);
  const ids = new Map<number, number>();
  const groupOf = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const size = count.get(root)!;
    if (size < 3) continue;
    if (!ids.has(root)) { ids.set(root, sizes.length); sizes.push(size); }
    groupOf[i] = ids.get(root)!;
  }
  const inGroups = sizes.reduce((a, b) => a + b, 0);
  return { groupOf, sizes, inGroups, largest: sizes.length ? Math.max(...sizes) : 0 };
}

function meanNearest(xs: ArrayLike<number>, zs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return NaN;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = (xs[i] - xs[j]) ** 2 + (zs[i] - zs[j]) ** 2;
      if (d < best) best = d;
    }
    sum += Math.sqrt(best);
  }
  return sum / n;
}

const nullCache = new Map<number, number>();

/** Mean nearest-neighbour distance of n points uniform in a disc of this radius (Monte Carlo, cached per n). */
function randomNearest(n: number, radius: number, rand: () => number): number {
  const key = n * 1000 + Math.round(radius);
  const hit = nullCache.get(key);
  if (hit !== undefined) return hit;
  let total = 0;
  const draws = 40;
  const xs = new Float64Array(n), zs = new Float64Array(n);
  for (let k = 0; k < draws; k++) {
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * radius;
      xs[i] = Math.cos(a) * d;
      zs[i] = Math.sin(a) * d;
    }
    total += meanNearest(xs, zs);
  }
  const v = total / draws;
  nullCache.set(key, v);
  return v;
}

/** Aggregation ratio: observed mean nearest-neighbour distance / random placement. < 1 means gathered. */
export function aggregation(xs: ArrayLike<number>, zs: ArrayLike<number>, radius: number, rand: () => number): number {
  if (xs.length < 3) return NaN;
  return meanNearest(xs, zs) / randomNearest(xs.length, radius, rand);
}
