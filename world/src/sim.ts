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
 */
import { Brain, DEFAULT_PARAMS, type BrainParams } from "./brain.ts";
import { Vision, type Kind, type Seen } from "./eyes.ts";
import { CH, Mechanosensors, OdourField, Olfaction, type Contact, type Emitter } from "./senses.ts";
import { mulberry32 } from "./rng.ts";
import { buildWiring, type Population, type Wiring } from "./wiring.ts";

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
}

const NAMES = [
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

  constructor(id: number, wiring: Wiring, seed: number, index: number) {
    this.id = id;
    this.sex = index % 2 === 0 ? "M" : "F";
    this.name = NAMES[index % NAMES.length];
    this.brain = new Brain(wiring, seed);
    this.vision = new Vision(wiring);
    this.smell = new Olfaction(wiring);
    this.mech = new Mechanosensors(wiring);
  }
}

interface PopRef { L: number; R: number }

export type EventKind = "mate" | "egg" | "hatch" | "feed" | "attack" | "death" | "poop";

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

export class World {
  readonly wiring: Wiring;
  readonly params: BrainParams = { ...DEFAULT_PARAMS };
  readonly flies: Fly[] = [];
  readonly props: Prop[] = [];
  readonly field: OdourField;
  /** the swatter, when one is coming down */
  threat: Prop | null = null;
  threatLife = 0;
  selected = 0;
  steps = 0;
  speedScale = 1;
  wind = { angle: 0.7, strength: 1.2 };
  odourStrength = 1;
  cvaStrength = 0.75;
  /** counters used by tools/ */
  landings = 0;
  feedSteps = 0;
  matings = 0;
  eggsLaid = 0;
  hatched = 0;
  deaths = { age: 0, starved: 0, swatted: 0, eaten: 0 };
  /** population history for the graph: [adults, larvae] every second */
  history: [number, number][] = [];
  /** one in-world day, in seconds */
  dayLength = 300;
  /** 0 = midnight, 0.5 = midday */
  timeOfDay = 0.32; // start mid-morning
  /** what just happened and where, for the markers on the map */
  events: WorldEvent[] = [];
  /** world seed: props, fly placement and brain noise all derive from it, so
   *  tools/ can run the same experiment on several independent worlds. */
  readonly seed: number;
  private rand: () => number;
  private seen: Seen[] = [];
  private emitters: Emitter[] = [];
  private points: Emitter[] = [];
  private pop: Record<string, PopRef> = {};
  private nextId = 1;
  private madeFlies = 0;
  private lastStrike = new Map<number, number>();

  constructor(flyCount: number, seed = 1234) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.field = new OdourField(seed + 99);
    this.wiring = buildWiring(64);
    this.buildProps();
    this.setFlyCount(flyCount);
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

  setFlyCount(n: number): void {
    n = Math.max(1, Math.min(MAX_FLIES, Math.round(n)));
    while (this.flies.length > n) this.flies.pop();
    while (this.flies.length < n) {
      const fly = new Fly(this.nextId++, this.wiring, this.seed * 31 + this.madeFlies * 7919, this.madeFlies);
      this.madeFlies++;
      const a = this.rand() * Math.PI * 2;
      const d = this.rand() * (WORLD_RADIUS * 0.5);
      fly.x = Math.cos(a) * d;
      fly.z = Math.sin(a) * d;
      fly.y = 1.5 + this.rand() * 2;
      fly.yaw = this.rand() * Math.PI * 2;
      fly.age = this.rand() * 180;
      fly.lifespan = 520 + this.rand() * 260;
      this.flies.push(fly);
    }
    if (this.selected >= this.flies.length) this.selected = 0;
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

  /** One 20 ms brain step for every fly, plus the physics that follows. */
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

  private mark(kind: EventKind, text: string, x: number, y: number, z: number): void {
    this.events.push({ kind, text, x, y, z, age: 0 });
    if (this.events.length > 40) this.events.shift();
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
        if (p.life <= 0) p.open = 0;
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
    for (const f of this.flies) {
      this.seen.push({ id: f.id, x: f.x, y: f.y, z: f.z, radius: 0.36, kind: "fly" });
      // every fly releases cVA, and a frightened one releases CO2
      this.points.push({ id: f.id, x: f.x, z: f.z, channel: CH.cva, strength: this.cvaStrength, point: true });
      const stress = this.rate("DNp01", "L", f) + this.rate("DNp01", "R", f);
      if (stress > 0.04) this.points.push({ id: f.id, x: f.x, z: f.z, channel: CH.co2, strength: Math.min(1, stress * 6), point: true });
    }
    this.field.points = this.points;
    this.field.step(dt, windX, windZ, this.emitters);

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
        const beat = o.motor.thrust / (1 + d2);
        if (dx * cos - dz * sin < 0) nbL += beat; else nbR += beat;
        // mid-air bump: both tumble
        if (d2 < 0.36 && !fly.landed && !o.landed) {
          fly.speed *= 0.35;
          fly.spin += (dx * cos - dz * sin < 0 ? 1 : -1) * 2.2;
          fly.vy += 0.9;
          if (dx * cos - dz * sin < 0) contact.knockL = 1; else contact.knockR = 1;
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
      fly.spin *= Math.exp(-dt / 0.45);
      fly.yaw += (MOTOR.turn * fly.motor.turn - 5.0 * (jumpR - jumpL) + fly.spin) * dt;
      const target = MOTOR.cruise * thrust - MOTOR.back * back + MOTOR.jump * jump;
      fly.speed += (target - fly.speed) * Math.min(1, 6 * dt);

      const step = fly.speed * dt;
      fly.x += Math.sin(fly.yaw) * step + windX * MOTOR.windCouple * dt;
      fly.z += Math.cos(fly.yaw) * step + windZ * MOTOR.windCouple * dt;
      fly.stats.distance += Math.abs(step);

      fly.vy += (MOTOR.lift * thrust - MOTOR.gravity - MOTOR.drag * fly.vy + MOTOR.jumpUp * jump) * dt;
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
        if (!wasLanded) this.landings++;
        if (prop && ECOLOGY[prop.kind].food && prop.open > 0.2) {
          // one marker per meal, not one per bounce off the fruit
          if (!fly.wasFeeding && fly.sinceFed > 4) {
            this.mark("feed", `${fly.name} eats ${prop.kind}`, fly.x, fly.y, fly.z);
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
          if (o.sex !== "F" || o.mated) continue;
          if (Math.hypot(fly.x - o.x, fly.y - o.y, fly.z - o.z) > 0.8) continue;
          // she is receptive if she is mature; once mated she carries his cVA,
          // which reaches AL-LN and shuts P1 down in every male that meets her
          if (o.age < 40) continue;
          o.mated = true;
          o.eggLoad += 10;
          this.matings++;
          this.mark("mate", `${fly.name} + ${o.name}`, fly.x, fly.y, fly.z);
          break;
        }
      }
      if (fly.sex === "F" && fly.mated && fly.eggLoad > 0 && fly.landed && prop && ECOLOGY[prop.kind].food) {
        // egg-laying drive: taste says "substrate", the lateral horn says
        // "geosmin". Mouldy fruit therefore gets no eggs without any rule.
        const lay = this.pair("LB3", fly) - this.pair("LH", fly);
        if (lay > 0 && this.rand() < lay * 12 * dt && this.props.length < 420) {
          fly.eggLoad--;
          this.eggsLaid++;
          this.mark("egg", `${fly.name} lays`, fly.x, fly.y, fly.z);
          this.place("egg", fly.x + (this.rand() - 0.5) * 0.4, fly.z + (this.rand() - 0.5) * 0.4,
            { radius: 0.12, height: prop.height + 0.02, y: prop.height, life: 25 });
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
        this.mark("poop", `${fly.name} leaves a dropping`, fly.x, fly.y, fly.z);
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
            if (Math.hypot(f.x - sp.x, f.z - sp.z) < 1.3 && f.y < 0.85) f.dead = "eaten";
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
      this.mark("death", `${f.name} ${DEATH_WORD[f.dead]}`, f.x, f.y, f.z);
      this.flies.splice(i, 1);
      if (this.selected >= this.flies.length) this.selected = Math.max(0, this.flies.length - 1);
      // a dead fly is carrion, which the amine channel already makes attractive
      this.place("carrion", f.x, f.z, { radius: 0.5, height: 0.45, y: 0.4, life: 220, open: 0.6 });
    }

    // ---- eggs hatch, larvae eat and pupate -------------------------------
    for (let i = this.props.length - 1; i >= 0; i--) {
      const p = this.props[i];
      if (p.kind === "egg") {
        if (p.life <= 0) {
          p.kind = "larva"; p.life = 45; p.radius = 0.18; this.hatched++;
          this.mark("hatch", "egg hatches", p.x, p.y + 0.2, p.z);
        }
      } else if (p.kind === "larva") {
        // it eats whatever it is sitting on
        for (const q of this.props) {
          if (!ECOLOGY[q.kind].food) continue;
          if (Math.hypot(p.x - q.x, p.z - q.z) < 1.6) { q.open = Math.max(0, q.open - 0.02 * dt); break; }
        }
        if (p.life <= 0) {
          this.props.splice(i, 1);
          if (this.flies.length < MAX_FLIES) {
            const fly = new Fly(this.nextId++, this.wiring, this.seed * 31 + this.madeFlies * 7919, this.madeFlies);
            this.madeFlies++;
            fly.x = p.x; fly.z = p.z; fly.y = 0.6;
            fly.yaw = this.rand() * Math.PI * 2;
            fly.lifespan = 520 + this.rand() * 260;
            this.flies.push(fly);
            this.mark("hatch", `${fly.name} emerges`, fly.x, fly.y, fly.z);
          }
        }
      } else if (p.kind === "carrion" && p.life !== Infinity && p.life <= 0) {
        this.props.splice(i, 1);
      }
    }

    // things regrow, slowly
    for (const p of this.props) {
      if (!ECOLOGY[p.kind].food) continue;
      if (p.open < 1) p.open = Math.min(1, p.open + 0.06 * dt);
    }
    if (this.steps % 50 === 0) {
      this.history.push([this.flies.length, this.props.filter((p) => p.kind === "larva" || p.kind === "egg").length]);
      if (this.history.length > 300) this.history.shift();
    }
    this.steps++;
  }
}
