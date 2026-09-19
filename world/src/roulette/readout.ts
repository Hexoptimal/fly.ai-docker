/**
 * Fly Roulette: what the fly sees and what we read back. Shared by the page's worker, the betting server
 * (mine/src/roulette.worker.ts) and tools/roulette.ts, so a turn is computed identically everywhere.
 *
 * In:  the toy gun looming (LPLC2 + LC4, both eyes), stronger the more chambers have clicked empty, and the
 *      trigger under its front legs (SNta touch neurons).
 * Out: wing-power motor neurons (take-off) and leg flexor motor neurons (the squeeze), counted over the window.
 *      The fly flies off when its flight motor fires past WING_BAIL; otherwise its legs squeeze the trigger.
 * No game rule decides anything: the chamber only sets how big the gun looks.
 */
import type { ConnectomeBrain, ConnectomeMeta } from "../connectome.ts";

export const READOUT = {
  warmSteps: 10,        // 0.2 s staring at the gun before the trigger touches its legs
  windowSteps: 30,      // 0.6 s: the decision
  touch: 0.15,          // voltage per step on SNta
  loomMin: 0.03,        // first chamber
  loomMax: 0.16,        // sixth chamber
  wingBail: 25,         // wing-power spikes in the window that mean take-off
};

export const WING_POWER = ["DLMn a, b", "DLMn c-f", "DVMn 1a-c", "DVMn 2a, b", "DVMn 3a, b"];
export const LEG_FLEX = ["Ti flexor MN", "Acc. ti flexor MN", "Tr flexor MN", "Acc. tr flexor MN"];

export const loomFor = (chamber: number) => READOUT.loomMin + (READOUT.loomMax - READOUT.loomMin) * Math.min(5, chamber) / 5;

export interface Counts { wing: number; grip: number; gf: number }
export const decide = (n: Counts): "fly" | "pull" => (n.wing >= READOUT.wingBail ? "fly" : "pull");

type CellsFn = (meta: ConnectomeMeta, names: string[], side?: "L" | "R") => Int32Array;
export function groups(meta: ConnectomeMeta, cells: CellsFn) {
  const mark = (idx: Int32Array) => { const m = new Uint8Array(meta.n); for (const i of idx) m[i] = 1; return m; };
  const touch: number[] = [];
  for (let i = 0; i < meta.n; i++) if (meta.types[meta.typeIdx[i]].startsWith("SNta")) touch.push(i);
  return {
    loom: cells(meta, ["LPLC2", "LC4"]),
    touch: Int32Array.from(touch),
    isWing: mark(cells(meta, WING_POWER)),
    isGrip: mark(cells(meta, LEG_FLEX)),
    isGf: mark(cells(meta, ["DNp01"])),
  };
}

export type Groups = ReturnType<typeof groups>;

/**
 * One turn of one fly, on its own brain (which keeps its state from earlier turns): it stares at the gun, then
 * feels the trigger while we count. onStep sees the running totals after each counted step.
 */
export function runTurn(b: ConnectomeBrain, g: Groups, chamber: number, onStep?: (n: Counts, t: number) => void): Counts & { choice: "fly" | "pull" } {
  const loom = loomFor(chamber);
  for (let k = 0; k < READOUT.warmSteps; k++) { b.stimulate(g.loom, loom); b.step(); }
  const n = { wing: 0, grip: 0, gf: 0 };
  for (let k = 0; k < READOUT.windowSteps; k++) {
    b.stimulate(g.loom, loom);
    b.stimulate(g.touch, READOUT.touch);
    b.step();
    for (let q = 0; q < b.firedCount; q++) {
      const i = b.fired[q];
      n.wing += g.isWing[i]; n.grip += g.isGrip[i]; n.gf += g.isGf[i];
    }
    onStep?.(n, (k + 1) / READOUT.windowSteps);
  }
  return { ...n, choice: decide(n) };
}
