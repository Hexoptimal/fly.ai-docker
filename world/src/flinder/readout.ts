/**
 * Flinder: what the swiping fly senses from a profile and what we read back. Shared by the page's worker and
 * tools/flinder.ts, so a swipe is computed the same way everywhere.
 *
 * In:  each profile trait drives the sense a real fly would use to size up a mate:
 *      musk  -> cVA pheromone smell (ORN_DA1, Or67d)        moves -> a courting fly in view (LC10a)
 *      snack -> a vinegar-scented date (ORN_VL2a, Ir84a)    scent -> body pheromones (ORN_VA1v, Or47b)
 *      song  -> wing song on the antennae (JO-B neurons)
 * Out: the pC1 cluster, the female fly's mating-drive neurons, counted over the window. The fly swipes right
 *      when pC1 fires past HEART. No game rule weighs the traits: the wiring does.
 */
import type { ConnectomeBrain, ConnectomeMeta } from "../connectome.ts";

export const READOUT = {
  warmSteps: 10,        // 0.2 s looking at the profile before we count
  windowSteps: 30,      // 0.6 s: the decision
  maxDrive: 0.3,        // voltage per step on a sense at trait 1
  heart: 90,            // pC1 spikes in the window that mean swipe right
  super: 120,           // ...and this many: a super like
};

export const TRAITS = ["musk", "moves", "snack", "scent", "song"] as const;
export type Trait = (typeof TRAITS)[number];
export type Traits = Record<Trait, number>;

export interface Counts { heart: number; vpo: number }
export const decide = (n: Counts): "right" | "left" => (n.heart >= READOUT.heart ? "right" : "left");

type CellsFn = (meta: ConnectomeMeta, names: string[], side?: "L" | "R") => Int32Array;
export function groups(meta: ConnectomeMeta, cells: CellsFn) {
  const byPrefix = (p: string) => {
    const a: number[] = [];
    for (let i = 0; i < meta.n; i++) if (meta.types[meta.typeIdx[i]].startsWith(p)) a.push(i);
    return Int32Array.from(a);
  };
  const mark = (idx: Int32Array) => { const m = new Uint8Array(meta.n); for (const i of idx) m[i] = 1; return m; };
  const sense: Record<Trait, Int32Array> = {
    musk: cells(meta, ["ORN_DA1"]),
    moves: cells(meta, ["LC10a"]),
    snack: cells(meta, ["ORN_VL2a"]),
    scent: cells(meta, ["ORN_VA1v"]),
    song: byPrefix("JO-B"),
  };
  return { sense, isHeart: mark(byPrefix("pC1")), isVpo: mark(cells(meta, ["DNp13"])) };
}

export type Groups = ReturnType<typeof groups>;

/**
 * One swipe on one fly's brain (which keeps its state from earlier swipes): it takes in the profile, then we
 * count pC1 (and vpoDN, DNp13, shown as the fly's blush). onStep sees the running totals after each counted step.
 */
export function runSwipe(b: ConnectomeBrain, g: Groups, t: Traits, onStep?: (n: Counts, p: number) => void): Counts & { choice: "right" | "left" } {
  const feel = () => { for (const k of TRAITS) if (t[k] > 0) b.stimulate(g.sense[k], t[k] * READOUT.maxDrive); };
  for (let k = 0; k < READOUT.warmSteps; k++) { feel(); b.step(); }
  const n = { heart: 0, vpo: 0 };
  for (let k = 0; k < READOUT.windowSteps; k++) {
    feel();
    b.step();
    for (let q = 0; q < b.firedCount; q++) { const i = b.fired[q]; n.heart += g.isHeart[i]; n.vpo += g.isVpo[i]; }
    onStep?.(n, (k + 1) / READOUT.windowSteps);
  }
  return { ...n, choice: decide(n) };
}

// ---- chat after a match -----------------------------------------------------------------------------------
/**
 * A chat is the two brains taking turns. Each message is something the reader senses: the sender's smell and
 * looks again (its profile at half strength) plus what the message carries. A flirty message is cVA and a
 * courting fly in view, stronger the harder the sender's pC1 fired; past COME_ON it also looms at the reader
 * (a fly rushing in). The reader's reply is whatever its brain does most: pC1 past HEART flirts back, the
 * giant fibre (DNp01) past SPOOK means it bails and unmatches, DNg12 (antenna grooming) past GROOM means it
 * wandered off to groom, and anything else is a dry reply.
 */
export const CHAT = {
  profile: 0.5,         // the sender's traits, felt at this share of a swipe's strength
  flirtMin: 0.08,       // a flirty message at the line...
  flirtMax: 0.3,        // ...and at FLIRT_FULL spikes and above
  flirtFull: 150,
  comeOn: 120,          // pC1 spikes past which the sender comes on strong and looms
  loom: 0.1,
  spook: 8,             // giant fibre spikes in the window that mean it bails
  groom: 65,            // antenna grooming spikes that mean it went to groom
  maxTurns: 10,
  dateAfter: 6,         // flirts in a row that set a date
};

export type Reply = "flirt" | "spooked" | "groom" | "dry";
export interface ChatCounts { heart: number; gf: number; groom: number }
export const replyOf = (n: ChatCounts): Reply =>
  n.gf >= CHAT.spook ? "spooked" : n.heart >= READOUT.heart ? "flirt" : n.groom >= CHAT.groom ? "groom" : "dry";

/** What a message carries to its reader: only a flirt carries anything; a dry one or a groom break is silence. */
export function carried(kind: Reply, heart: number): { flirt: number; loom: number } {
  if (kind !== "flirt") return { flirt: 0, loom: 0 };
  const k = Math.min(1, Math.max(0, (heart - READOUT.heart) / (CHAT.flirtFull - READOUT.heart)));
  return { flirt: CHAT.flirtMin + (CHAT.flirtMax - CHAT.flirtMin) * k, loom: heart >= CHAT.comeOn ? CHAT.loom : 0 };
}

export type ChatGroups = ReturnType<typeof chatGroups>;
export function chatGroups(meta: ConnectomeMeta, cells: CellsFn, g: Groups) {
  const mark = (idx: Int32Array) => { const m = new Uint8Array(meta.n); for (const i of idx) m[i] = 1; return m; };
  const groom: number[] = [];
  for (let i = 0; i < meta.n; i++) if (meta.types[meta.typeIdx[i]].startsWith("DNg12")) groom.push(i);
  return { ...g, loom: cells(meta, ["LPLC2", "LC4"]), isGf: mark(cells(meta, ["DNp01"])), isGroom: mark(Int32Array.from(groom)) };
}

/** One reply: the reader's brain reads a message from a sender with these traits. */
export function runReply(b: ConnectomeBrain, g: ChatGroups, sender: Traits, msg: { flirt: number; loom: number }): ChatCounts & { reply: Reply } {
  const feel = () => {
    for (const k of TRAITS) if (sender[k] > 0) b.stimulate(g.sense[k], sender[k] * READOUT.maxDrive * CHAT.profile);
    if (msg.flirt > 0) { b.stimulate(g.sense.musk, msg.flirt); b.stimulate(g.sense.moves, msg.flirt); }
    if (msg.loom > 0) b.stimulate(g.loom, msg.loom);
  };
  for (let k = 0; k < READOUT.warmSteps; k++) { feel(); b.step(); }
  const n = { heart: 0, gf: 0, groom: 0 };
  for (let k = 0; k < READOUT.windowSteps; k++) {
    feel();
    b.step();
    for (let q = 0; q < b.firedCount; q++) { const i = b.fired[q]; n.heart += g.isHeart[i]; n.gf += g.isGf[i]; n.groom += g.isGroom[i]; }
  }
  return { ...n, reply: replyOf(n) };
}

export type Ending = "date" | "ghosted" | "unmatched" | "texting";
/**
 * Where a chat stands after its latest message (messages alternate, the swiper's opener first): a spooked
 * reply unmatches; two non-flirty replies in a row from one fly is a ghosting; six flirts in a row set a
 * date; out of turns, they're still texting. null: keep going.
 */
export function ending(msgs: Reply[]): Ending | null {
  const n = msgs.length, last = msgs[n - 1];
  if (last === "spooked") return "unmatched";
  if (n >= CHAT.dateAfter && msgs.slice(-CHAT.dateAfter).every((m) => m === "flirt")) return "date";
  if (n >= 3 && last !== "flirt" && msgs[n - 3] !== "flirt") return "ghosted";
  return n >= CHAT.maxTurns ? "texting" : null;
}

// ---- extras ------------------------------------------------------------------------------------------------
/**
 * A profile that "just left another date" carries a rival's cVA on it. To a fly that is more of the same smell,
 * so it adds to the musk the swiper senses (and cVA raises pC1 in this brain: the rival makes it hotter).
 */
export const RIVAL = 0.35;
export const sensed = (t: Traits, rival: boolean): Traits => (rival ? { ...t, musk: Math.min(1, t.musk + RIVAL) } : t);

/** A date: each fly reads the other up close (its last flirt at full reach). Both brains decide how it goes. */
export type DateEnd = "together" | "bailed" | "groomed" | "awkward";
export const dateEnd = (a: Reply, b: Reply): DateEnd =>
  a === "spooked" || b === "spooked" ? "bailed" : a === "flirt" && b === "flirt" ? "together" : a === "groom" || b === "groom" ? "groomed" : "awkward";
