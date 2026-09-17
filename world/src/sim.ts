/**
 * The world and the loop: senses -> brain -> descending neurons -> VNC ->
 * motor neurons -> body.
 *
 * Flight is read from the MOTOR NEURONS, not from the descending neurons: wing
 * power from the DLM motor neurons, steering from the b1/b2 basalar motor
 * neurons, take-off from the tibia extensor and sternotrochanter, backing off
 * from the leg flexors. There is no rule that says "go to the fruit", "avoid the
 * mould" or "land now": those come out of which sensory type the situation
 * drives, and which way that type is wired.
 *
 * Life (2026-09-15): every fly has a genome (genome.ts). Founders draw theirs; a mated female carries the male's
 * genome, and each egg gets a child genome from both parents. Eggs and larvae can die (BROOD). Who is near whom is
 * recorded (social.ts) and everything is logged for export (datalog.ts). Learning during life is off unless
 * `world.learning` switches it on (brain.ts).
 */
import { Brain, DEFAULT_PARAMS, type BrainParams, type Learning } from "./brain.ts";
import { Vision, type Kind, type Seen } from "./eyes.ts";
import { CH, Mechanosensors, OdourField, Olfaction, type Contact, type Emitter } from "./senses.ts";
import { mulberry32 } from "./rng.ts";
import { buildWiring, weightsFor, EDGES, POPULATIONS, type Population, type Wiring } from "./wiring.ts";
import { child, founder, summary, type Genome } from "./genome.ts";
import { aggregation, findGroups, NEAR_M, Social, STARTLE_CLOSING, STARTLE_M, type Kin, type PairStats } from "./social.ts";
import { DataLog, FLY_EVERY_S, round, type Row } from "./datalog.ts";

export const WORLD_RADIUS = 32;
export const MAX_FLIES = 80;
export const GROUND = 0.42;
export const SKY = 12; // a safety clamp, not an altitude controller

/** Motor neuron rate (Hz) -> body. The only hand-written mapping. */
export const MOTOR = {
  maxRate: 50,
  turn: 9.0, // rad/s at full b1/b2 left-right difference
  cruise: 12.0, // m/s at full DLM wing power
  back: 5.0, // m/s at full leg flexor rate
  jump: 12.0, // m/s of take-off burst
  jumpUp: 16.0, // m/s^2 upward during that burst
  lift: 30.0, // m/s^2 of lift at full DLM rate
  gravity: 6.5, // m/s^2
  drag: 3.5,
  windCouple: 0.9, // a flying insect is carried by the air almost completely
};

/**
 * How eggs and larvae die (per second unless noted). World rules, like the timings; set 2026-09-15.
 *   background     any egg or larva, any time
 *   mould          on a mouldy substrate
 *   bare           the substrate is eaten down below bareBelow (or gone): nothing to eat, dries out
 *   crowd          per brood item beyond crowdFree within crowdM
 *   trample        chance per adult landing within trampleM
 *   spider         every egg and larva within spiderM of a spider when it strikes
 */
export const BROOD = {
  eggS: 25, larvaS: 45,
  background: { egg: 0.004, larva: 0.003 },
  mould: 0.03,
  bare: 0.02, bareBelow: 0.15,
  crowd: 0.004, crowdFree: 6, crowdM: 1.2,
  trample: 0.1, trampleM: 0.3,
  spiderM: 1.3,
};

/** Reward signals for the reward-gated learning rule (brain.ts). */
export const REWARD = { meal: 1, knock: -0.3, spiderNear: -1, spiderNearM: 2.2 };

/** What each kind of thing in the world smells of, and whether a fly can feed
 *  on it. Strength is multiplied by `open` (how much of it is left). */
export const ECOLOGY: Record<string, { odour: [number, number][]; food: boolean; label: string }> = {
  fruit: { odour: [[CH.ester, 1.0], [CH.butyrate, 0.8], [CH.acid, 0.35]], food: true, label: "fermenting fruit" },
  mould: { odour: [[CH.ester, 0.45], [CH.butyrate, 0.35], [CH.geosmin, 1.0]], food: true, label: "mouldy fruit (geosmin)" },
  carrion: { odour: [[CH.amine, 1.0], [CH.co2, 0.25]], food: true, label: "carrion (amines)" },
  dung: { odour: [[CH.amine, 0.7], [CH.acid, 0.15]], food: true, label: "dung (amines)" },
  compost: { odour: [[CH.ester, 0.5], [CH.butyrate, 0.6], [CH.acid, 0.4], [CH.co2, 1.0]], food: true, label: "compost (food + CO2)" },
  plant: { odour: [], food: false, label: "plant" },
  spider: { odour: [], food: false, label: "spider" },
  egg: { odour: [], food: false, label: "egg" },
  larva: { odour: [[CH.amine, 0.25]], food: false, label: "larva" },
  poop: { odour: [[CH.amine, 0.35]], food: false, label: "fly dropping" },
  obstacle: { odour: [], food: false, label: "rock" },
  threat: { odour: [], food: false, label: "swatter" },
  fly: { odour: [], food: false, label: "fly" },
};

export interface Brood {
  id: number;
  mother: number;
  father: number;
  motherName: string;
  fatherName: string;
  genome: Genome;
  generation: number;
  substrateId: number;
}

export interface Prop {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  z: number;
  radius: number; // how big it looks and smells
  open: number; // 0..1, how much is left
  height: number; // the surface a fly can stand on
  shape: number;
  species: number; // which visual variant
  life: number; // for droppings
  /** eggs and larvae: who they came from and what they will become */
  brood?: Brood;
}

export const NAMES = [
  "Buzz", "Maggie", "Grub", "Vinnie", "Pupa", "Nibbles", "Zipper", "Whiff", "Gus", "Blot",
  "Speck", "Twitch", "Compound", "Larva", "Scuttle", "Drizzle", "Ferment", "Wobble", "Titch", "Grease",
  "Bristle", "Mould", "Sticky", "Pong", "Squirm", "Flitter", "Crumb", "Dizzy", "Hover", "Splat",
  "Rot", "Fuzz", "Jitter", "Muck", "Nub", "Ooze", "Prickle", "Quiver", "Reek", "Skitter",
  "Smudge", "Snap", "Tangle", "Thrum", "Trundle", "Vex", "Wheeze", "Yeast", "Zest", "Bumble",
  "Cider", "Dregs", "Ester", "Frass", "Gnat", "Husk", "Itch", "Jam", "Kipper", "Lurch",
  "Midge", "Nectar", "Offal", "Pickle", "Quibble", "Rasp", "Sump", "Tipple", "Umber", "Vat",
  "Wisp", "Xylem", "Yolk", "Zymo", "Brack", "Cruft", "Damp", "Ewe", "Fettle", "Glum",
];

export type FlyState = "PANIC" | "SURGING" | "CASTING" | "FEEDING" | "LANDED" | "TAKE-OFF" | "FLYING";

/** tonic scale per neuron: the wiring's resting drive times this fly's gene for that population */
function tonicFor(wiring: Wiring, genes: Float32Array): Float32Array {
  const out = new Float32Array(wiring.n);
  for (let i = 0; i < wiring.n; i++) out[i] = wiring.tonicScale[i] * (genes[wiring.popOf[i] >> 1] ?? 1);
  return out;
}

export class Fly {
  brain: Brain;
  vision: Vision;
  smell: Olfaction;
  mech: Mechanosensors;
  x = 0; y = 2; z = 0;
  yaw = 0;
  speed = 0;
  vy = 0;
  spin = 0; // tumbling after a collision
  wing = 0;
  landed = false;
  feeding = false;
  state: FlyState = "FLYING";
  sinceHit = 99; // seconds since the last phasic odour hit
  gut = 0; // how much has been eaten since the last dropping
  contact: Contact = { loadL: 0, loadR: 0, knockL: 0, knockR: 0, taste: 0 };
  motor = { turn: 0, thrust: 0, back: 0, jump: 0 };
  dn = { turn: 0, thrust: 0, back: 0, escape: 0 };
  /** live scoreboard */
  stats = { fed: 0, distance: 0, panics: 0, swatted: 0 };
  sex: "M" | "F" = "M";
  age = 0; // seconds
  lifespan = 600;
  mated = false;
  eggLoad = 0;
  sinceFed = 0;
  courting = 0; // P1 rate, for the UI
  wasFeeding = false; // so a meal is one event, not one per step
  dead: "" | "age" | "starved" | "swatted" | "eaten" = "";
  readonly id: number;
  readonly name: string;
  readonly genome: Genome;
  generation = 0;
  mother: number | null = null;
  father: number | null = null;
  born = 0;
  meals = 0;
  matings = 0;
  /** the genome a mated female carries for her eggs */
  sperm: { id: number; name: string; genome: Genome; generation: number } | null = null;
  escaping = false;
  knocked = false;

  constructor(id: number, wiring: Wiring, seed: number, index: number, genome: Genome, sex?: "M" | "F") {
    this.id = id;
    this.sex = sex ?? (index % 2 === 0 ? "M" : "F");
    this.name = NAMES[index % NAMES.length];
    this.genome = genome;
    this.lifespan = genome.lifespan;
    this.brain = new Brain(wiring, seed, weightsFor(wiring, genome.edge), tonicFor(wiring, genome.tonic));
    Object.assign(this.brain.modalityGain, genome.sense);
    this.brain.learnScale = { hebb: genome.learn.hebb, reward: genome.learn.reward, mb: genome.learn.mb };
    this.vision = new Vision(wiring);
    this.smell = new Olfaction(wiring);
    this.mech = new Mechanosensors(wiring);
  }
}

interface PopRef { L: number; R: number }

export type EventKind = "mate" | "egg" | "hatch" | "feed" | "attack" | "death" | "poop" | "arrive";

const DEATH_WORD: Record<string, string> = {
  age: "dies of old age",
  starved: "starves",
  swatted: "is swatted",
  eaten: "is eaten",
};

export interface WorldEvent {
  kind: EventKind;
  /** fly or prop name / cause, shown next to the marker */
  text: string;
  x: number; y: number; z: number;
  /** seconds since it happened */
  age: number;
}

/** A genome as plain JSON, with the block and population names its arrays are aligned to. */
export interface GenomeJson {
  edge: number[];
  tonic: number[];
  sense: Record<string, number>;
  learn: Genome["learn"];
  lifespan: number;
  flight: number;
  clutch: number;
}

/**
 * Everything needed to carry a world across a restart (server/run.ts). Not bit-exact: random streams are reseeded,
 * membrane voltages and odour puffs start fresh (they settle within a second), and the recent-rows tables are not kept
 * (they were already uploaded). Flies, genes, learned synapses, eggs, lineage, relationships and counters are.
 * Brain weights are kept only if the wiring is the same shape; if a deploy changed the wiring, genes are carried over
 * by block and population name and brains restart from what the genes build.
 */
export interface WorldCheckpoint {
  version: 1;
  seed: number;
  savedAt: number;
  wiring: { n: number; nnz: number; edges: string[]; pops: string[] };
  world: Record<string, unknown>;
  flies: (Record<string, unknown> & { genome: GenomeJson; weight: Float32Array | null })[];
  props: Record<string, unknown>[];
  kin: Kin[];
  pairs: PairStats[];
  lineage: Row[];
  brood: Row[];
}

const edgeKey = (e: { from: string; to: string; mode: string }) => `${e.from}>${e.to}:${e.mode}`;

function genomeToJson(g: Genome): GenomeJson {
  return { edge: Array.from(g.edge), tonic: Array.from(g.tonic), sense: { ...g.sense }, learn: { ...g.learn }, lifespan: g.lifespan, flight: g.flight, clutch: g.clutch };
}

/** Rebuild a genome, remapping its arrays by block and population name if the wiring has changed since it was saved. */
function genomeFromJson(j: GenomeJson, edges: string[], pops: string[]): Genome {
  const edgeAt = new Map(edges.map((k, i) => [k, i]));
  const popAt = new Map(pops.map((k, i) => [k, i]));
  return {
    edge: Float32Array.from(EDGES, (e) => j.edge[edgeAt.get(edgeKey(e)) ?? -1] ?? 1),
    tonic: Float32Array.from(POPULATIONS, (p) => j.tonic[popAt.get(p.name) ?? -1] ?? 1),
    sense: { ...j.sense },
    learn: { hebb: j.learn.hebb ?? 1, reward: j.learn.reward ?? 1, mb: j.learn.mb ?? 1 },
    lifespan: j.lifespan, flight: j.flight, clutch: j.clutch,
  };
}

/** JSON has no Infinity: props that never expire are stored with life null. */
const finite = (x: number) => (Number.isFinite(x) ? x : null);

export interface WorldOptions {
  /** "vary": founders draw their genes; "fixed": every founder gets the mean genome (old behaviour, tools) */
  genes?: "vary" | "fixed";
  learning?: Learning;
}

export class World {
  readonly wiring: Wiring;
  readonly params: BrainParams = { ...DEFAULT_PARAMS };
  readonly flies: Fly[] = [];
  readonly props: Prop[] = [];
  readonly field: OdourField;
  /** the swatter, when one is coming down */
  threat: Prop | null = null;
  threatLife = 0;
  /** Wiz (wiz.ts), when summoned: flies see him like anything else that looms */
  giant: Seen | null = null;
  selected = 0;
  steps = 0;
  speedScale = 1;
  /** most adults the field holds: a larva that would make more dies of "no room" (the server lowers it to fit its CPU) */
  maxFlies = MAX_FLIES;
  wind = { angle: 0.7, strength: 1.2 };
  odourStrength = 1;
  cvaStrength = 0.75;
  /** counters used by tools/ */
  landings = 0;
  feedSteps = 0;
  matings = 0;
  eggsLaid = 0;
  hatched = 0;
  emerged = 0;
  deaths = { age: 0, starved: 0, swatted: 0, eaten: 0 };
  /** eggs and larvae that died, by cause */
  broodDeaths: Record<string, number> = {};
  /** population history for the graph: [adults, larvae] every second */
  history: [number, number][] = [];
  /** one in-world day, in seconds */
  dayLength = 300;
  /** 0 = midnight, 0.5 = midday */
  timeOfDay = 0.32; // start mid-morning
  /** what just happened and where, for the markers on the map */
  events: WorldEvent[] = [];
  /** which learning rules every brain runs (shared object: flip a field and every fly follows) */
  readonly learning: Learning;
  readonly social = new Social();
  readonly log = new DataLog();
  readonly kin = new Map<number, Kin>();
  /** latest groups / aggregation sample, for the panel */
  latest = { groups: 0, inGroups: 0, largest: 0, aggregation: NaN, groupOf: new Map<number, number>() };
  /** world seed: props, fly placement and brain noise all derive from it, so
   *  tools/ can run the same experiment on several independent worlds. */
  readonly seed: number;
  private rand: () => number;
  private geneRand: () => number;
  private readonly genes: "vary" | "fixed";
  private seen: Seen[] = [];
  private emitters: Emitter[] = [];
  private points: Emitter[] = [];
  private pop: Record<string, PopRef> = {};
  private nextId = 1;
  private madeFlies = 0;
  private lastStrike = new Map<number, number>();

  constructor(flyCount: number, seed = 1234, opts: WorldOptions = {}) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.geneRand = mulberry32(seed ^ 0x5eed5);
    this.genes = opts.genes ?? "vary";
    this.learning = opts.learning ?? { hebbian: false, reward: false, mb: true };
    this.field = new OdourField(seed + 99);
    this.wiring = buildWiring(64);
    this.buildProps();
    this.setFlyCount(flyCount);
  }

  /** seconds since the world started */
  get time(): number {
    return this.steps * this.params.dt;
  }

  /** everything that could be seen during the last step (props, flies, the swatter, Wiz) */
  get visible(): readonly Seen[] {
    return this.seen;
  }

  population(name: string, side: "L" | "R"): Population {
    return this.wiring.index.get(name + "_" + side)!;
  }

  private place(kind: Kind, x: number, z: number, opts: Partial<Prop> = {}): Prop {
    const r = this.rand;
    const p: Prop = {
      id: this.nextId++, kind, x, z, y: 0.45, radius: 1.0, open: 1,
      height: 0.6, shape: r(), species: 0, life: Infinity, ...opts,
    };
    this.props.push(p);
    return p;
  }

  private buildProps(): void {
    const r = this.rand;
    const spot = (minR: number) => {
      const a = r() * Math.PI * 2;
      const d = minR + Math.sqrt(r()) * (WORLD_RADIUS - minR - 6);
      return [Math.cos(a) * d, Math.sin(a) * d] as const;
    };

    // four patches of good fermenting fruit
    for (let patch = 0; patch < 4; patch++) {
      const [cx, cz] = spot(5);
      for (let i = 0; i < 3; i++) {
        const a = r() * Math.PI * 2, rad = r() * 3.5;
        this.place("fruit", cx + Math.cos(a) * rad, cz + Math.sin(a) * rad,
          { height: 0.55 + r() * 0.3, species: patch % 3 });
      }
    }
    // three patches of mouldy fruit: the same food, plus geosmin
    for (let patch = 0; patch < 3; patch++) {
      const [cx, cz] = spot(5);
      for (let i = 0; i < 3; i++) {
        const a = r() * Math.PI * 2, rad = r() * 3.5;
        this.place("mould", cx + Math.cos(a) * rad, cz + Math.sin(a) * rad,
          { height: 0.55 + r() * 0.3 });
      }
    }
    // carrion, dung, one compost heap
    for (let i = 0; i < 2; i++) {
      const [x, z] = spot(7);
      this.place("carrion", x, z, { radius: 1.4, height: 0.75 });
    }
    for (let i = 0; i < 4; i++) {
      const [x, z] = spot(6);
      this.place("dung", x, z, { radius: 0.9, height: 0.4 });
    }
    const [hx, hz] = spot(10);
    this.place("compost", hx, hz, { radius: 2.6, height: 1.6 });

    // plants: things to land on and fly around
    for (let i = 0; i < 16; i++) {
      const [x, z] = spot(4);
      this.place("plant", x, z, { radius: 0.8 + r() * 0.5, height: 1.2 + r() * 1.6 });
    }
    // rocks
    for (let i = 0; i < 9; i++) {
      const [x, z] = spot(7);
      const h = 1.6 + r() * 3.5;
      this.place("obstacle", x, z, { radius: 1.2 + r() * 1.4, height: h, y: h * 0.5 });
    }
    // spiders: the reason the giant fibre matters
    for (let i = 0; i < 5; i++) {
      const [x, z] = spot(6);
      this.place("spider", x, z, { radius: 0.7, height: 0.5, y: 0.4 });
    }
    // the ring that keeps them in the field
    const ring = 22;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2, d = WORLD_RADIUS - 2;
      this.place("obstacle", Math.cos(a) * d, Math.sin(a) * d,
        { radius: 3.2, height: 7 + r() * 3, y: 4 });
    }
  }

  private fixedGenome(): Genome {
    const g = founder(() => 0.5);
    g.edge.fill(1); g.tonic.fill(1);
    for (const k of Object.keys(g.sense)) g.sense[k] = 1;
    g.learn = { hebb: 1, reward: 1, mb: 1 };
    g.lifespan = 650; g.flight = 1; g.clutch = 10;
    return g;
  }

  /** a new fly: founders have no parents; a brood item brings its genome and parents */
  private makeFly(genome: Genome, brood?: Brood): Fly {
    const sex = brood ? (this.geneRand() < 0.5 ? "M" : "F") : undefined;
    const fly = new Fly(this.nextId++, this.wiring, this.seed * 31 + this.madeFlies * 7919, this.madeFlies, genome, sex);
    this.madeFlies++;
    fly.born = this.time;
    fly.brain.learning = this.learning;
    if (brood) {
      fly.generation = brood.generation;
      fly.mother = brood.mother;
      fly.father = brood.father;
    }
    this.kin.set(fly.id, { id: fly.id, mother: fly.mother, father: fly.father });
    this.log.lineage.set(fly.id, {
      id: fly.id, name: fly.name, sex: fly.sex, generation: fly.generation, born_t: round(fly.born, 1),
      mother: fly.mother, mother_name: brood?.motherName ?? null, father: fly.father, father_name: brood?.fatherName ?? null,
      brood_id: brood?.id ?? null, ...Object.fromEntries(Object.entries(summary(genome)).map(([k, v]) => [k, round(v, 4)])),
      offspring: 0, matings: 0, died_t: null, cause: null, age_at_death: null, meals: null, fed_s: null, distance_m: null,
      final_drift: null, pairings: null, rewards: null,
    });
    return fly;
  }

  setFlyCount(n: number): void {
    n = Math.max(1, Math.min(this.maxFlies, Math.round(n)));
    while (this.flies.length > n) this.recordDeath(this.flies.pop()!, "removed");
    while (this.flies.length < n) {
      const genome = this.genes === "fixed" ? this.fixedGenome() : founder(this.geneRand);
      const fly = this.makeFly(genome);
      const a = this.rand() * Math.PI * 2;
      const d = this.rand() * (WORLD_RADIUS * 0.5);
      fly.x = Math.cos(a) * d;
      fly.z = Math.sin(a) * d;
      fly.y = 1.5 + this.rand() * 2;
      fly.yaw = this.rand() * Math.PI * 2;
      fly.age = this.rand() * 180;
      if (this.genes === "fixed") fly.lifespan = 520 + this.rand() * 260;
      else this.rand();                                   // keep the placement stream as it was
      this.flies.push(fly);
    }
    if (this.selected >= this.flies.length) this.selected = 0;
  }

  /**
   * A newcomer flies in from the edge of the field: a founder with fresh genes and no parents. The always-on server
   * uses this when the population falls below its floor, so the world never runs empty. It is logged as an "arrive"
   * event and marked immigrant in the lineage table, so the data can tell arrivals from births.
   */
  addImmigrant(): Fly {
    const fly = this.makeFly(founder(this.geneRand));
    const a = this.rand() * Math.PI * 2;
    fly.x = Math.cos(a) * WORLD_RADIUS * 0.8;
    fly.z = Math.sin(a) * WORLD_RADIUS * 0.8;
    fly.y = 2.5;
    fly.yaw = a + Math.PI;
    this.flies.push(fly);
    const row = this.log.lineage.get(fly.id);
    if (row) row.immigrant = true;
    this.mark("arrive", `${fly.name} flies in`, fly.x, fly.y, fly.z, { fly: fly.id });
    return fly;
  }

  /**
   * Drop what only the past needs, so a world that runs for months does not grow without end: lineage rows of flies
   * dead longer than `keepS` (unless a living fly or a waiting egg names them as a parent), finished egg rows, kin
   * entries nobody alive refers to, and relationships between two flies that are both gone. Call it only after those
   * rows have been saved somewhere.
   */
  forget(keepS: number): { lineage: number; brood: number; kin: number; pairs: number } {
    const alive = new Set(this.flies.map((f) => f.id));
    const parents = new Set<number>();
    for (const f of this.flies) { if (f.mother !== null) parents.add(f.mother); if (f.father !== null) parents.add(f.father); }
    for (const p of this.props) if (p.brood) { parents.add(p.brood.mother); parents.add(p.brood.father); }
    const old = (t: unknown) => typeof t === "number" && this.time - t > keepS;
    const gone = { lineage: 0, brood: 0, kin: 0, pairs: 0 };
    for (const [id, row] of this.log.lineage) {
      if (!alive.has(id) && !parents.has(id) && old(row.died_t)) { this.log.lineage.delete(id); gone.lineage++; }
    }
    for (const [id, row] of this.log.brood) {
      if ((row.fate === "died" || row.fate === "emerged") && old(row.fate_t)) { this.log.brood.delete(id); gone.brood++; }
    }
    for (const id of [...this.kin.keys()]) {
      if (!alive.has(id) && !parents.has(id)) { this.kin.delete(id); gone.kin++; }
    }
    for (const [k, p] of this.social.pairs) {
      if (!alive.has(p.a) && !alive.has(p.b)) { this.social.pairs.delete(k); gone.pairs++; }
    }
    return gone;
  }

  toCheckpoint(): WorldCheckpoint {
    const flyJson = this.flies.map((f) => ({
      id: f.id, name: f.name, sex: f.sex, generation: f.generation, mother: f.mother, father: f.father, born: f.born,
      age: f.age, lifespan: f.lifespan, x: f.x, y: f.y, z: f.z, yaw: f.yaw, speed: f.speed, vy: f.vy, landed: f.landed,
      state: f.state, gut: f.gut, stats: { ...f.stats }, mated: f.mated, eggLoad: f.eggLoad, sinceFed: f.sinceFed,
      meals: f.meals, matings: f.matings,
      sperm: f.sperm ? { id: f.sperm.id, name: f.sperm.name, generation: f.sperm.generation, genome: genomeToJson(f.sperm.genome) } : null,
      brain: { pairings: f.brain.pairings, rewards: f.brain.rewards, depressed: f.brain.depressed },
      genome: genomeToJson(f.genome),
      weight: f.brain.weight.slice(),
    }));
    return {
      version: 1,
      seed: this.seed,
      savedAt: this.time,
      wiring: { n: this.wiring.n, nnz: this.wiring.nnz, edges: EDGES.map(edgeKey), pops: POPULATIONS.map((p) => p.name) },
      world: {
        steps: this.steps, timeOfDay: this.timeOfDay, wind: { ...this.wind }, odourStrength: this.odourStrength,
        cvaStrength: this.cvaStrength, landings: this.landings, feedSteps: this.feedSteps, matings: this.matings,
        eggsLaid: this.eggsLaid, hatched: this.hatched, emerged: this.emerged, deaths: { ...this.deaths },
        broodDeaths: { ...this.broodDeaths }, history: this.history, nextId: this.nextId, madeFlies: this.madeFlies,
        learning: { ...this.learning }, genes: this.genes,
      },
      flies: flyJson,
      props: this.props.map((p) => ({
        ...p, life: finite(p.life),
        brood: p.brood ? { ...p.brood, genome: genomeToJson(p.brood.genome) } : undefined,
      })),
      kin: [...this.kin.values()],
      pairs: [...this.social.pairs.values()],
      lineage: [...this.log.lineage.values()],
      brood: [...this.log.brood.values()],
    };
  }

  /** Rebuild a world from toCheckpoint(). See WorldCheckpoint for what is and is not carried over. */
  static fromCheckpoint(c: WorldCheckpoint): { world: World; weightsKept: boolean } {
    const w = c.world as Record<string, any>;
    const world = new World(1, c.seed, { genes: w.genes, learning: w.learning });
    world.flies.length = 0;
    world.props.length = 0;
    world.kin.clear();
    world.log.lineage.clear();
    world.log.brood.clear();
    world.rand = mulberry32((c.seed ^ w.steps) >>> 0);
    world.geneRand = mulberry32((c.seed ^ 0x5eed5 ^ w.steps) >>> 0);
    world.steps = w.steps;
    world.timeOfDay = w.timeOfDay;
    Object.assign(world.wind, w.wind);
    world.odourStrength = w.odourStrength;
    world.cvaStrength = w.cvaStrength;
    world.landings = w.landings; world.feedSteps = w.feedSteps; world.matings = w.matings;
    world.eggsLaid = w.eggsLaid; world.hatched = w.hatched; world.emerged = w.emerged;
    Object.assign(world.deaths, w.deaths);
    world.broodDeaths = { ...w.broodDeaths };
    world.history = w.history ?? [];
    const sameShape = c.wiring.n === world.wiring.n && c.wiring.nnz === world.wiring.nnz &&
      c.wiring.edges.join("|") === EDGES.map(edgeKey).join("|") && c.wiring.pops.join("|") === POPULATIONS.map((p) => p.name).join("|");
    const genome = (j: GenomeJson) => genomeFromJson(j, c.wiring.edges, c.wiring.pops);
    for (const j of c.flies as Record<string, any>[]) {
      const index = Math.max(0, NAMES.indexOf(j.name));
      const fly = new Fly(j.id, world.wiring, (c.seed * 31 + j.id * 7919) >>> 0, index, genome(j.genome), j.sex);
      Object.assign(fly, {
        generation: j.generation, mother: j.mother, father: j.father, born: j.born, age: j.age, lifespan: j.lifespan,
        x: j.x, y: j.y, z: j.z, yaw: j.yaw, speed: j.speed, vy: j.vy, landed: j.landed, state: j.state, gut: j.gut,
        mated: j.mated, eggLoad: j.eggLoad, sinceFed: j.sinceFed, meals: j.meals, matings: j.matings,
      });
      Object.assign(fly.stats, j.stats);
      fly.sperm = j.sperm ? { ...j.sperm, genome: genome(j.sperm.genome) } : null;
      fly.brain.learning = world.learning;
      fly.brain.pairings = j.brain.pairings; fly.brain.rewards = j.brain.rewards; fly.brain.depressed = j.brain.depressed;
      if (sameShape && j.weight) fly.brain.weight.set(j.weight as Float32Array);
      world.flies.push(fly);
    }
    for (const p of c.props as Record<string, any>[]) {
      world.props.push({
        ...p, life: p.life === null ? Infinity : p.life,
        brood: p.brood ? { ...p.brood, genome: genome(p.brood.genome) } : undefined,
      } as Prop);
    }
    for (const k of c.kin) world.kin.set(k.id, k);
    for (const p of c.pairs) world.social.pairs.set(p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`, { ...p });
    for (const r of c.lineage) world.log.lineage.set(Number(r.id), r);
    for (const r of c.brood) world.log.brood.set(Number(r.id), r);
    world.nextId = w.nextId;
    world.madeFlies = w.madeFlies;
    return { world, weightsKept: sameShape };
  }

  /** Bring the swatter down over the flies. */
  dropThreat(): void {
    const a = this.rand() * Math.PI * 2;
    const d = this.rand() * WORLD_RADIUS * 0.4;
    this.threat = {
      id: this.nextId++, kind: "threat", x: Math.cos(a) * d, z: Math.sin(a) * d,
      y: 22, radius: 3.4, open: 1, height: 5, shape: 0, species: 0, life: Infinity,
    };
    this.threatLife = 6;
  }

  rate(name: string, side: "L" | "R", fly: Fly): number {
    let ref = this.pop[name];
    if (!ref) {
      ref = this.pop[name] = {
        L: this.wiring.pops.findIndex((p) => p.name === name && p.side === "L"),
        R: this.wiring.pops.findIndex((p) => p.name === name && p.side === "R"),
      };
    }
    return fly.brain.rateOf(ref[side]) / MOTOR.maxRate;
  }

  pair(name: string, fly: Fly): number {
    return (this.rate(name, "L", fly) + this.rate(name, "R", fly)) * 0.5;
  }

  /** Wind vector (the direction the air moves), in m/s. */
  windVector(): [number, number] {
    return [Math.sin(this.wind.angle) * this.wind.strength, Math.cos(this.wind.angle) * this.wind.strength];
  }

  private surfaceAt(fly: Fly): { support: number; prop: Prop | null } {
    let support = -Infinity;
    let prop: Prop | null = null;
    for (const p of this.props) {
      if (p.kind === "obstacle") continue;
      const pad = p.kind === "plant" ? p.radius * 0.9 : Math.max(1.3, p.radius * 1.3);
      if (Math.hypot(fly.x - p.x, fly.z - p.z) > pad) continue;
      if (fly.y > p.height + 1.0 || fly.y < p.height - 0.9) continue;
      if (p.height > support) { support = p.height; prop = p; }
    }
    if (fly.y <= GROUND + 0.02 && support < GROUND) { support = GROUND; prop = null; }
    return { support, prop };
  }

  /** Daylight, 0 at night and 1 at midday: a smooth sun elevation curve.
   *  This is not decoration - it scales the luminance the photoreceptors see,
   *  so a fly at night is genuinely working with a darker panorama. */
  get daylight(): number {
    const elev = Math.sin((this.timeOfDay - 0.25) * Math.PI * 2);
    return Math.max(0.12, Math.min(1, 0.5 + elev * 1.1));
  }

  /** hh:mm of the in-world clock */
  get clock(): string {
    const mins = Math.floor(this.timeOfDay * 24 * 60);
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  }

  private mark(kind: EventKind, text: string, x: number, y: number, z: number, ids: Row = {}): void {
    this.events.push({ kind, text, x, y, z, age: 0 });
    if (this.events.length > 40) this.events.shift();
    this.log.events.push({ t: round(this.time, 2), clock: this.clock, kind, text, x: round(x, 2), z: round(z, 2), ...ids });
  }

  private recordDeath(f: Fly, cause: string): void {
    const row = this.log.lineage.get(f.id);
    if (!row) return;
    Object.assign(row, {
      died_t: round(this.time, 1), cause, age_at_death: round(f.age, 1), meals: f.meals, fed_s: round(f.stats.fed * this.params.dt, 1),
      distance_m: round(f.stats.distance, 1), final_drift: round(f.brain.drift(), 5), pairings: f.brain.pairings,
      rewards: round(f.brain.rewards, 2), matings: f.matings,
    });
  }

  private broodDies(p: Prop, cause: string): void {
    const key = `${p.kind}:${cause}`;
    this.broodDeaths[key] = (this.broodDeaths[key] ?? 0) + 1;
    if (p.brood) {
      const row = this.log.brood.get(p.brood.id);
      if (row) Object.assign(row, { fate: "died", cause, stage: p.kind, fate_t: round(this.time, 1) });
    }
    const i = this.props.indexOf(p);
    if (i >= 0) this.props.splice(i, 1);
  }

  step(): void {
    const dt = this.params.dt;
    const t = this.steps * dt;
    this.timeOfDay = (this.timeOfDay + dt / this.dayLength) % 1;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      e.age += dt;
      if (e.age > 6) this.events.splice(i, 1);
    }
    this.wind.angle += 0.12 * Math.sin(t * 0.07) * dt;
    const [windX, windZ] = this.windVector();

    // ---- the world as it can be seen and smelled --------------------------
    this.seen.length = 0;
    this.emitters.length = 0;
    this.points.length = 0;
    for (const p of this.props) {
      if (p.life !== Infinity) {
        p.life -= dt;
        if (p.life <= 0 && !p.brood) p.open = 0;
      }
      const eco = ECOLOGY[p.kind];
      for (const [channel, strength] of eco.odour) {
        this.emitters.push({ id: p.id, x: p.x, z: p.z, channel, strength: strength * p.open });
      }
      if (p.kind === "poop" && p.open <= 0) continue;
      if (eco.food && p.open < 0.2) continue;
      this.seen.push({ id: p.id, x: p.x, y: p.y, z: p.z, radius: p.radius * (eco.food ? p.open : 1), kind: p.kind });
    }
    if (this.threat) {
      const th = this.threat;
      this.seen.push({ id: th.id, x: th.x, y: th.y, z: th.z, radius: th.radius, kind: "threat" });
      th.y = Math.max(0.8, th.y - 26 * dt);
      this.threatLife -= dt;
      if (this.threatLife <= 0) this.threat = null;
    }
    if (this.giant) this.seen.push(this.giant);
    for (const f of this.flies) {
      this.seen.push({ id: f.id, x: f.x, y: f.y, z: f.z, radius: 0.36, kind: "fly" });
      // every fly releases cVA, and a frightened one releases CO2
      this.points.push({ id: f.id, x: f.x, z: f.z, channel: CH.cva, strength: this.cvaStrength, point: true });
      const stress = this.rate("DNp01", "L", f) + this.rate("DNp01", "R", f);
      if (stress > 0.04) this.points.push({ id: f.id, x: f.x, z: f.z, channel: CH.co2, strength: Math.min(1, stress * 6), point: true });
    }
    this.field.points = this.points;
    this.field.step(dt, windX, windZ, this.emitters);

    // a spider rearing up nearby or the swatter makes an escape a scare, not a startle by another fly
    const rearing = this.props.filter((p) => p.kind === "spider" && p.life !== Infinity);

    // ---- every fly ---------------------------------------------------------
    for (const fly of this.flies) {
      const cos = Math.cos(fly.yaw), sin = Math.sin(fly.yaw);
      const contact = fly.contact;
      contact.loadL = contact.loadR = contact.knockL = contact.knockR = contact.taste = 0;
      const { support, prop } = this.surfaceAt(fly);

      // ageing: the receptors inject less and the motor populations rest lower,
      // so an old fly is visibly a worse flier. No health bar anywhere.
      fly.age += dt;
      const old = Math.min(1, fly.age / fly.lifespan);
      fly.brain.senseGain = 1 - 0.55 * old * old;
      fly.brain.tonicGain = 1 - 0.30 * old * old;

      fly.vision.look(fly.brain, fly.x, fly.y, fly.z, fly.yaw, this.seen, fly.id, this.daylight);
      fly.smell.sniff(fly.brain, fly.x, fly.z, fly.yaw, this.field, this.odourStrength, dt, fly.id);

      let nbL = 0, nbR = 0;
      for (const o of this.flies) {
        if (o === fly) continue;
        const dx = o.x - fly.x, dz = o.z - fly.z, dy = o.y - fly.y;
        const d2 = dx * dx + dz * dz + dy * dy;
        if (d2 > 16) continue;
        if (d2 < NEAR_M * NEAR_M) this.social.get(fly.id, o.id).near += dt / 2; // each pair is visited twice
        const beat = o.motor.thrust / (1 + d2);
        if (dx * cos - dz * sin < 0) nbL += beat; else nbR += beat;
        // mid-air bump: both tumble
        if (d2 < 0.36 && !fly.landed && !o.landed) {
          fly.speed *= 0.35;
          fly.spin += (dx * cos - dz * sin < 0 ? 1 : -1) * 2.2;
          fly.vy += 0.9;
          if (dx * cos - dz * sin < 0) contact.knockL = 1; else contact.knockR = 1;
          const pair = this.social.get(fly.id, o.id);
          if (pair.lastBump < this.steps - 1) pair.bumps++;       // a new collision, not the same one continuing
          pair.lastBump = this.steps;
        }
      }

      // foreleg contact chemoreceptors: a male tapping a female. Gr68a is a
      // contact sense, so it is a near field, not a plume.
      if (fly.sex === "M") {
        let pherL = 0, pherR = 0;
        for (const o of this.flies) {
          if (o === fly || o.sex !== "F") continue;
          const dx = o.x - fly.x, dz = o.z - fly.z, dy = o.y - fly.y;
          const d2 = dx * dx + dz * dz + dy * dy;
          if (d2 > 6.25) continue;
          const amount = 0.75 / (1 + d2 * 4);
          if (dx * cos - dz * sin < 0) pherL += amount; else pherR += amount;
        }
        if (pherL > 0) fly.brain.stimulate(this.population("Gr68a", "L"), Math.min(0.8, pherL));
        if (pherR > 0) fly.brain.stimulate(this.population("Gr68a", "R"), Math.min(0.8, pherR));
      }

      const vx = sin * fly.speed, vz = cos * fly.speed;
      const airX = windX - vx, airZ = windZ - vz;
      if (support > -Infinity) {
        contact.loadL = contact.loadR = 1;
        if (prop && ECOLOGY[prop.kind].food) contact.taste = prop.open;
      }
      // ventral optic flow: ground speed over height above whatever is below
      const flow = Math.abs(fly.speed) / Math.max(0.35, fly.y - (support > -Infinity ? support : GROUND));
      fly.mech.sense(fly.brain, fly.yaw, airX, airZ, fly.motor.thrust, nbL, nbR, contact, flow, dt);

      fly.brain.step(this.params);

      fly.dn = {
        turn: this.rate("DNa02", "R", fly) - this.rate("DNa02", "L", fly),
        thrust: this.pair("DNg100", fly),
        back: this.pair("MDN", fly),
        escape: this.pair("DNp01", fly),
      };

      // a startle: the giant fibre fires while one fly is closing in within STARTLE_M (no spider rearing close, no
      // swatter). Only the nearest such fly is blamed; an escape near flies that are not approaching blames nobody.
      const escaping = fly.dn.escape > 0.12;
      if (escaping && !fly.escaping && !this.threat &&
          !rearing.some((s) => Math.hypot(s.x - fly.x, s.z - fly.z) < 4)) {
        let culprit: Fly | null = null, best = STARTLE_M;
        for (const o of this.flies) {
          if (o === fly) continue;
          const dx = o.x - fly.x, dy = o.y - fly.y, dz = o.z - fly.z;
          const d = Math.hypot(dx, dy, dz);
          if (d >= best || d < 1e-6) continue;
          // closing speed: the other fly's velocity toward this one, minus this one's own motion toward it
          const ovx = Math.sin(o.yaw) * o.speed, ovz = Math.cos(o.yaw) * o.speed;
          const fvx = Math.sin(fly.yaw) * fly.speed, fvz = Math.cos(fly.yaw) * fly.speed;
          const closing = -((ovx - fvx) * dx + (o.vy - fly.vy) * dy + (ovz - fvz) * dz) / d;
          if (closing > STARTLE_CLOSING) { culprit = o; best = d; }
        }
        if (culprit) this.social.get(fly.id, culprit.id).startles++;
      }
      fly.escaping = escaping;

      // ---- read the MOTOR NEURONS: this is flight -------------------------
      const thrust = this.pair("DLM MN", fly);
      const steerL = this.rate("b1 MN", "L", fly) + this.rate("b2 MN", "L", fly);
      const steerR = this.rate("b1 MN", "R", fly) + this.rate("b2 MN", "R", fly);
      const back = (this.pair("Ti flexor MN", fly) + this.pair("Tr flexor MN", fly)) * 0.5;
      const jumpL = this.rate("Ti extensor MN", "L", fly) + this.rate("Sternotrochanter MN", "L", fly);
      const jumpR = this.rate("Ti extensor MN", "R", fly) + this.rate("Sternotrochanter MN", "R", fly);
      const jump = (jumpL + jumpR) * 0.5;
      fly.motor = { turn: (steerR - steerL) * 0.5, thrust, back, jump };

      // ---- body -------------------------------------------------------------
      const power = fly.genome.flight;
      fly.spin *= Math.exp(-dt / 0.45);
      fly.yaw += (MOTOR.turn * fly.motor.turn - 5.0 * (jumpR - jumpL) + fly.spin) * dt;
      const target = MOTOR.cruise * thrust * power - MOTOR.back * back + MOTOR.jump * jump;
      fly.speed += (target - fly.speed) * Math.min(1, 6 * dt);

      const step = fly.speed * dt;
      fly.x += Math.sin(fly.yaw) * step + windX * MOTOR.windCouple * dt;
      fly.z += Math.cos(fly.yaw) * step + windZ * MOTOR.windCouple * dt;
      fly.stats.distance += Math.abs(step);

      fly.vy += (MOTOR.lift * thrust * power - MOTOR.gravity - MOTOR.drag * fly.vy + MOTOR.jumpUp * jump) * dt;
      fly.y += fly.vy * dt;

      const wasLanded = fly.landed;
      fly.landed = false;
      fly.wasFeeding = fly.feeding;
      fly.feeding = false;
      if (support > -Infinity && fly.y <= support + 0.02) {
        fly.y = support;
        if (fly.vy < 0) fly.vy = 0;
        fly.speed *= 0.55;
        fly.landed = true;
        if (!wasLanded) {
          this.landings++;
          // landing on eggs or larvae can crush them
          for (const b of this.props) {
            if ((b.kind === "egg" || b.kind === "larva") && Math.hypot(b.x - fly.x, b.z - fly.z) < BROOD.trampleM &&
                this.rand() < BROOD.trample) b.life = -1e9;       // marked; removed with its cause below
          }
        }
        if (prop && ECOLOGY[prop.kind].food && prop.open > 0.2) {
          // one marker per meal, not one per bounce off the fruit
          if (!fly.wasFeeding && fly.sinceFed > 4) {
            this.mark("feed", `${fly.name} eats ${prop.kind}`, fly.x, fly.y, fly.z, { fly: fly.id });
          }
          if (!fly.wasFeeding) {
            fly.meals++;
            fly.brain.reward(REWARD.meal);
          }
          fly.feeding = true;
          fly.stats.fed++;
          fly.gut += dt;
          fly.sinceFed = 0;
          this.feedSteps++;
          prop.open = Math.max(0, prop.open - 0.9 * dt);
        }
      }
      if (fly.y < GROUND) { fly.y = GROUND; if (fly.vy < 0) fly.vy = 0; }
      if (fly.y > SKY) { fly.y = SKY; fly.vy = Math.min(fly.vy, 0); }

      // solid things push back, and the hair plates feel the knock
      for (const p of this.props) {
        if (p.kind !== "obstacle" && p.kind !== "plant") continue;
        const dx = fly.x - p.x, dz = fly.z - p.z;
        const d = Math.hypot(dx, dz), min = p.radius + 0.35;
        if (d < min && d > 1e-4 && fly.y < p.height + 0.6) {
          fly.x = p.x + (dx / d) * min;
          fly.z = p.z + (dz / d) * min;
          fly.speed *= 0.5;
          fly.spin += (this.rand() - 0.5) * 2;
          if ((-dx * cos + dz * sin) < 0) contact.knockL = 1; else contact.knockR = 1;
        }
      }
      const knocked = contact.knockL > 0 || contact.knockR > 0;
      if (knocked && !fly.knocked) fly.brain.reward(REWARD.knock);
      fly.knocked = knocked;
      const rad = Math.hypot(fly.x, fly.z);
      if (rad > WORLD_RADIUS) { fly.x *= WORLD_RADIUS / rad; fly.z *= WORLD_RADIUS / rad; }

      // the swatter connects
      if (this.threat && Math.hypot(fly.x - this.threat.x, fly.z - this.threat.z) < this.threat.radius &&
          fly.y < this.threat.y + 0.3 && fly.y > this.threat.y - 0.5) {
        fly.stats.swatted++;
        fly.dead = "swatted";
      }

      // ---- courtship and eggs, read off P1 and the taste/aversion balance ---
      fly.courting = this.pair("P1", fly) * MOTOR.maxRate;
      if (fly.sex === "M" && fly.courting > 6) {
        for (const o of this.flies) {
          if (o.sex !== "F") continue;
          if (Math.hypot(fly.x - o.x, fly.y - o.y, fly.z - o.z) > 0.8) continue;
          this.social.get(fly.id, o.id).courtships += dt;
          if (o.mated) continue;
          // she is receptive if she is mature; once mated she carries his cVA,
          // which reaches AL-LN and shuts P1 down in every male that meets her
          if (o.age < 40) continue;
          o.mated = true;
          o.eggLoad += Math.round(o.genome.clutch);
          o.sperm = { id: fly.id, name: fly.name, genome: fly.genome, generation: fly.generation };
          fly.matings++;
          o.matings++;
          this.social.get(fly.id, o.id).matings++;
          this.matings++;
          this.mark("mate", `${fly.name} + ${o.name}`, fly.x, fly.y, fly.z, { fly: fly.id, other: o.id });
          break;
        }
      }
      if (fly.sex === "F" && fly.mated && fly.sperm && fly.eggLoad > 0 && fly.landed && prop && ECOLOGY[prop.kind].food) {
        // egg-laying drive: taste says "substrate", the lateral horn says
        // "geosmin". Mouldy fruit therefore gets no eggs without any rule.
        const lay = this.pair("LB3", fly) - this.pair("LH", fly);
        if (lay > 0 && this.rand() < lay * 12 * dt && this.props.length < 420) {
          fly.eggLoad--;
          this.eggsLaid++;
          const brood: Brood = {
            id: this.eggsLaid, mother: fly.id, father: fly.sperm.id, motherName: fly.name, fatherName: fly.sperm.name,
            genome: child(fly.genome, fly.sperm.genome, this.geneRand),
            generation: Math.max(fly.generation, fly.sperm.generation) + 1, substrateId: prop.id,
          };
          this.mark("egg", `${fly.name} lays`, fly.x, fly.y, fly.z, { fly: fly.id, other: fly.sperm.id, brood: brood.id });
          this.place("egg", fly.x + (this.rand() - 0.5) * 0.4, fly.z + (this.rand() - 0.5) * 0.4,
            { radius: 0.12, height: prop.height + 0.02, y: prop.height, life: BROOD.eggS, brood });
          this.log.brood.set(brood.id, {
            id: brood.id, laid_t: round(this.time, 1), mother: fly.id, mother_name: fly.name, father: brood.father,
            father_name: brood.fatherName, generation: brood.generation, substrate: prop.kind,
            fate: "egg", stage: "egg", cause: null, hatched_t: null, fate_t: null, child: null,
          });
        }
      }

      fly.wing += (6 + 48 * Math.max(0.05, thrust + jump)) * dt;
      fly.sinceHit = fly.smell.hit > 0.06 ? 0 : fly.sinceHit + dt;

      // ---- a dropping, once enough has been eaten --------------------------
      if (fly.gut > 3.5) {
        fly.gut = 0;
        const poops = this.props.filter((p) => p.kind === "poop");
        if (poops.length > 36) {
          const oldest = poops.reduce((a, b) => (a.life < b.life ? a : b));
          this.props.splice(this.props.indexOf(oldest), 1);
        }
        this.place("poop", fly.x + (this.rand() - 0.5) * 0.3, fly.z + (this.rand() - 0.5) * 0.3,
          { radius: 0.3, height: 0.46, y: 0.44, life: 150 });
        this.mark("poop", `${fly.name} leaves a dropping`, fly.x, fly.y, fly.z, { fly: fly.id });
      }

      // ---- the label above its head, read straight off the populations -----
      const upwind = -(Math.sin(fly.yaw) * windX + Math.cos(fly.yaw) * windZ) /
        Math.max(0.05, this.wind.strength);
      if (fly.dn.escape > 0.12) { fly.state = "PANIC"; if (wasLanded || fly.state !== "PANIC") fly.stats.panics++; }
      else if (fly.feeding) fly.state = "FEEDING";
      else if (jump > 0.2 && !fly.landed) fly.state = "TAKE-OFF";
      else if (fly.landed) fly.state = "LANDED";
      else if (fly.sinceHit < 0.7 && upwind > 0.1 && thrust > 0.12) fly.state = "SURGING";
      else if (fly.sinceHit > 1.5 && Math.abs(fly.motor.turn) > 0.05) fly.state = "CASTING";
      else fly.state = "FLYING";
    }

    // ---- spiders --------------------------------------------------------
    // A spider rears up when a fly comes close (its radius grows, which is real
    // looming the eyes can see) and then strikes. A fly still on the ground when
    // it strikes is eaten. This is the giant fibre's job.
    for (const sp of this.props) {
      if (sp.kind !== "spider") continue;
      let near = false;
      for (const f of this.flies) {
        if (Math.hypot(f.x - sp.x, f.z - sp.z) < 2.2 && f.y < 1.1) { near = true; break; }
      }
      if (near && sp.life === Infinity) sp.life = 0.9; // rearing up
      if (sp.life !== Infinity) {
        sp.life -= dt;
        sp.radius = 0.7 + 1.6 * Math.max(0, 1 - sp.life / 0.9); // the loom
        if (sp.life <= 0) {
          for (const f of this.flies) {
            if (f.dead) continue;
            const d = Math.hypot(f.x - sp.x, f.z - sp.z);
            if (d < 1.3 && f.y < 0.85) f.dead = "eaten";
            else if (d < REWARD.spiderNearM) f.brain.reward(REWARD.spiderNear);
          }
          for (const b of this.props) {
            if ((b.kind === "egg" || b.kind === "larva") && Math.hypot(b.x - sp.x, b.z - sp.z) < BROOD.spiderM) b.life = -2e9;
          }
          // a kill is always worth a marker; a miss at most once every 8 s per
          // spider, or the feed is nothing but spiders
          const killed = this.flies.some((f) => f.dead === "eaten" && Math.hypot(f.x - sp.x, f.z - sp.z) < 1.3);
          const last = this.lastStrike.get(sp.id) ?? -99;
          if (killed || t - last > 8) {
            this.lastStrike.set(sp.id, t);
            this.mark("attack", killed ? "spider catches a fly" : "spider strikes, misses", sp.x, sp.y + 0.5, sp.z);
          }
          sp.life = Infinity;
          sp.radius = 0.7;
        }
      }
    }

    // ---- ageing, starvation, and what is left behind ---------------------
    for (const f of this.flies) {
      f.sinceFed += dt;
      if (!f.dead && f.age > f.lifespan) f.dead = "age";
      if (!f.dead && f.sinceFed > 240) f.dead = "starved";
    }
    for (let i = this.flies.length - 1; i >= 0; i--) {
      const f = this.flies[i];
      if (!f.dead) continue;
      this.deaths[f.dead]++;
      this.recordDeath(f, f.dead);
      this.mark("death", `${f.name} ${DEATH_WORD[f.dead]}`, f.x, f.y, f.z, { fly: f.id, cause: f.dead });
      this.flies.splice(i, 1);
      if (this.selected >= this.flies.length) this.selected = Math.max(0, this.flies.length - 1);
      // a dead fly is carrion, which the amine channel already makes attractive
      this.place("carrion", f.x, f.z, { radius: 0.5, height: 0.45, y: 0.4, life: 220, open: 0.6 });
    }

    // ---- eggs and larvae: die, hatch, eat, pupate ------------------------
    const byId = new Map<number, Prop>();
    const brood: Prop[] = [];
    for (const p of this.props) {
      byId.set(p.id, p);
      if (p.kind === "egg" || p.kind === "larva") brood.push(p);
    }
    for (const p of brood) {
      if (p.life < -1.5e9) { this.broodDies(p, "spider"); continue; }       // marked -2e9 at the strike
      if (p.life < -5e8) { this.broodDies(p, "trampled"); continue; }       // marked -1e9 at the landing
      const stage = p.kind as "egg" | "larva";
      const substrate = p.brood ? byId.get(p.brood.substrateId) : undefined;
      let crowd = 0;
      for (const q of brood) if (q !== p && Math.hypot(q.x - p.x, q.z - p.z) < BROOD.crowdM) crowd++;
      const hazards: [string, number][] = [
        ["background", BROOD.background[stage]],
        ["mould", substrate?.kind === "mould" ? BROOD.mould : 0],
        ["bare substrate", !substrate || substrate.open < BROOD.bareBelow ? BROOD.bare : 0],
        ["crowding", BROOD.crowd * Math.max(0, crowd - BROOD.crowdFree)],
      ];
      const total = hazards.reduce((a, [, h]) => a + h, 0);
      if (this.rand() < total * dt) {
        let pickAt = this.rand() * total;
        const cause = hazards.find(([, h]) => (pickAt -= h) <= 0)?.[0] ?? "background";
        this.broodDies(p, cause);
        continue;
      }
      if (stage === "egg") {
        if (p.life <= 0) {
          p.kind = "larva"; p.life = BROOD.larvaS; p.radius = 0.18; this.hatched++;
          this.mark("hatch", "egg hatches", p.x, p.y + 0.2, p.z, { brood: p.brood?.id });
          const row = p.brood ? this.log.brood.get(p.brood.id) : undefined;
          if (row) Object.assign(row, { fate: "larva", stage: "larva", hatched_t: round(this.time, 1) });
        }
        continue;
      }
      // a larva eats whatever it is sitting on
      for (const q of this.props) {
        if (!ECOLOGY[q.kind].food) continue;
        if (Math.hypot(p.x - q.x, p.z - q.z) < 1.6) { q.open = Math.max(0, q.open - 0.02 * dt); break; }
      }
      if (p.life <= 0) {
        if (this.flies.length >= this.maxFlies || !p.brood) { this.broodDies(p, "no room"); continue; }
        this.props.splice(this.props.indexOf(p), 1);
        const fly = this.makeFly(p.brood.genome, p.brood);
        fly.x = p.x; fly.z = p.z; fly.y = 0.6;
        fly.yaw = this.rand() * Math.PI * 2;
        this.flies.push(fly);
        this.emerged++;
        for (const parent of [p.brood.mother, p.brood.father]) {
          const row = this.log.lineage.get(parent);
          if (row) row.offspring = Number(row.offspring ?? 0) + 1;
        }
        const row = this.log.brood.get(p.brood.id);
        if (row) Object.assign(row, { fate: "emerged", stage: "adult", fate_t: round(this.time, 1), child: fly.id });
        this.mark("hatch", `${fly.name} emerges`, fly.x, fly.y, fly.z, { fly: fly.id, brood: p.brood.id });
      }
    }
    for (let i = this.props.length - 1; i >= 0; i--) {
      const p = this.props[i];
      if (p.kind === "carrion" && p.life !== Infinity && p.life <= 0) this.props.splice(i, 1);
    }

    // things regrow, slowly
    for (const p of this.props) {
      if (!ECOLOGY[p.kind].food) continue;
      if (p.open < 1) p.open = Math.min(1, p.open + 0.06 * dt);
    }
    if (this.steps % 50 === 0) {
      this.history.push([this.flies.length, this.props.filter((p) => p.kind === "larva" || p.kind === "egg").length]);
      if (this.history.length > 300) this.history.shift();
      this.sample();
    }
    this.steps++;
  }

  /** Once a second: groups, aggregation, relationships and brains into the log. */
  private sample(): void {
    const flies = this.flies;
    const xs = flies.map((f) => f.x), ys = flies.map((f) => f.y), zs = flies.map((f) => f.z);
    const g = findGroups(xs, ys, zs);
    const agg = aggregation(xs, zs, WORLD_RADIUS - 2, this.geneRand);
    const food = this.props.filter((p) => ECOLOGY[p.kind].food && p.open > 0.2);
    let groupedAtFood = 0;
    flies.forEach((f, i) => {
      if (g.groupOf[i] >= 0 && food.some((p) => Math.hypot(p.x - f.x, p.z - f.z) < Math.max(2.5, p.radius * 1.5))) groupedAtFood++;
    });
    const drifts = flies.map((f) => f.brain.drift());
    const gens = flies.map((f) => f.generation);
    this.latest = {
      groups: g.sizes.length, inGroups: g.inGroups, largest: g.largest, aggregation: agg,
      groupOf: new Map(flies.map((f, i) => [f.id, g.groupOf[i]])),
    };
    const labels = this.relationshipCounts();
    const brood = this.props.filter((p) => p.kind === "egg" || p.kind === "larva");
    const broodDeaths = Object.values(this.broodDeaths).reduce((a, b) => a + b, 0);
    const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
    this.log.world.push({
      t: round(this.time, 1), clock: this.clock, adults: flies.length, males: flies.filter((f) => f.sex === "M").length,
      eggs: brood.filter((p) => p.kind === "egg").length, larvae: brood.filter((p) => p.kind === "larva").length,
      groups: g.sizes.length, largest_group: g.largest, share_in_groups: round(flies.length ? g.inGroups / flies.length : 0),
      grouped_at_food: round(g.inGroups ? groupedAtFood / g.inGroups : 0), aggregation: round(agg),
      mean_drift: round(mean(drifts), 5), max_drift: round(drifts.length ? Math.max(...drifts) : 0, 5),
      mean_generation: round(mean(gens), 2), max_generation: gens.length ? Math.max(...gens) : 0,
      ...labels, matings: this.matings, eggs_laid: this.eggsLaid, hatched: this.hatched, emerged: this.emerged,
      brood_deaths: broodDeaths, deaths: Object.values(this.deaths).reduce((a, b) => a + b, 0),
      mean_memory: round(mean(flies.map((f) => f.brain.memoryDepth())), 5),
      learning: [this.learning.hebbian && "hebbian", this.learning.reward && "reward", this.learning.mb && "memory"]
        .filter(Boolean).join("+") || "off",
    });

    if (Math.round(this.time) % FLY_EVERY_S !== 0) return;
    flies.forEach((f, i) => {
      let near = 0;
      for (const o of flies) if (o !== f && Math.hypot(o.x - f.x, o.y - f.y, o.z - f.z) < 2) near++;
      this.log.flies.push({
        t: round(this.time, 1), id: f.id, name: f.name, sex: f.sex, generation: f.generation, age: round(f.age, 1),
        x: round(f.x, 2), y: round(f.y, 2), z: round(f.z, 2), state: f.state, meals: f.meals,
        fed_s: round(f.stats.fed * this.params.dt, 1), since_fed: round(f.sinceFed, 1), drift: round(drifts[i], 5),
        pairings: f.brain.pairings, memory: round(f.brain.memoryDepth(), 4),
        mbon_toward_hz: round(this.pair("MBON-g2a1", f) * MOTOR.maxRate, 2),
        mbon_away_hz: round(this.pair("MBON-g5b2a", f) * MOTOR.maxRate, 2),
        kc_hz: round(this.pair("KC", f) * MOTOR.maxRate, 2),
        dnp01_hz: round(this.pair("DNp01", f) * MOTOR.maxRate, 2),
        p1_hz: round(this.pair("P1", f) * MOTOR.maxRate, 2), dlm_hz: round(this.pair("DLM MN", f) * MOTOR.maxRate, 2),
        lh_hz: round(this.pair("LH", f) * MOTOR.maxRate, 2), lb3_hz: round(this.pair("LB3", f) * MOTOR.maxRate, 2),
        flies_within_2m: near, group: g.groupOf[i],
      });
    });
  }

  /** Relationship labels between flies alive now (social.ts). */
  relationshipCounts(): Record<string, number> {
    const alive = new Set(this.flies.map((f) => f.id));
    const out: Record<string, number> = { mates: 0, family: 0, enemies: 0, friends: 0, acquaintances: 0 };
    for (const p of this.social.pairs.values()) {
      if (!alive.has(p.a) || !alive.has(p.b)) continue;
      const label = Social.label(p, Social.isFamily(this.kin.get(p.a), this.kin.get(p.b)));
      if (label) out[label]++;
    }
    return out;
  }

  /** Every pair with any history, labelled, for export. */
  relationshipRows(): Row[] {
    const name = (id: number) => (this.log.lineage.get(id)?.name as string) ?? String(id);
    const alive = new Set(this.flies.map((f) => f.id));
    const rows: Row[] = [];
    for (const p of this.social.pairs.values()) {
      const family = Social.isFamily(this.kin.get(p.a), this.kin.get(p.b));
      rows.push({
        a: p.a, a_name: name(p.a), b: p.b, b_name: name(p.b), both_alive: alive.has(p.a) && alive.has(p.b),
        near_s: round(p.near, 1), bumps: round(p.bumps, 1), startles: p.startles, courtship_s: round(p.courtships, 1),
        matings: p.matings, family, tension: round(Social.tension(p), 1), label: Social.label(p, family) || "none",
      });
    }
    return rows;
  }

  /** How far each connection block has moved on average across living flies (for export). */
  driftByBlock(): Row[] {
    const n = EDGES.length;
    const sum = new Float32Array(n);
    for (const f of this.flies) {
      const d = f.brain.driftByEdge(n);
      for (let i = 0; i < n; i++) sum[i] += d[i];
    }
    return EDGES.map((e, i) => ({
      block: i, from: e.from, to: e.to, mode: e.mode, mean_change: round(this.flies.length ? sum[i] / this.flies.length : 0, 5),
    }));
  }
}
