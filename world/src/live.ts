/**
 * The shared world: the page watches the always-on server's field (server/live.ts) instead of simulating its own, so
 * every visitor sees the same flies. The server streams frames; this fills the page's World with them, so the
 * renderer, labels and panels read it exactly as they read a local world. Nothing is stepped here.
 *
 * Positions arrive 10 times a second and are interpolated between frames. The watched fly's brain (rates, sense
 * drives, spikes of every step) comes with each frame; picking another fly reconnects with ?fly=<id>.
 */
import { founder } from "./genome.ts";
import { mulberry32 } from "./rng.ts";
import { Fly, NAMES, type FlyState, type Prop, type World } from "./sim.ts";
import type { Kind, Seen } from "./eyes.ts";
import type { Row } from "./datalog.ts";
import type { Kin, PairStats } from "./social.ts";

export const LIVE_URL: string = (import.meta.env.VITE_WORLD_SERVER as string | undefined) ?? "https://fly-world-sim.fly.dev";

const FRAME_MS = 100;
const STATES: FlyState[] = ["PANIC", "SURGING", "CASTING", "FEEDING", "LANDED", "TAKE-OFF", "FLYING"];

type FlyRow = [number, number, number, number, number, number, number, number, number, number];
type PropRow = [number, Kind, number, number, number, number, number, number, number, number];
interface Detail {
  id: number; name: string; sex: "M" | "F"; generation: number; mother: number | null; father: number | null;
  mother_name: string | null; father_name: string | null; age: number; mated: boolean;
  stats: { fed: number; distance: number; panics: number; swatted: number };
}
interface Header {
  steps: number; tod: number; wind: { angle: number; strength: number }; threat: [number, number, number] | null;
  counts: { matings: number; eggsLaid: number; hatched: number; emerged: number; deaths: World["deaths"] };
  puffs: number; maxFlies: number; learning: World["learning"]; viewers: number;
}
interface Frame extends Header {
  flies: FlyRow[]; props: PropRow[]; gone?: number[]; details?: Detail[]; history?: [number, number][] | [number, number];
  events?: { kind: World["events"][number]["kind"]; text: string; x: number; y: number; z: number; age: number }[];
  focus?: number;
}
interface BrainMsg {
  /** spikes: one base64 bitset per simulation step, bit i set = neuron i fired */
  id: number; rate: number[]; spikes: string[];
  vision: Record<string, number>; smell: Record<string, [number, number]>;
  mech: { jo: [number, number]; leg: [number, number]; load: [number, number]; taste: number; flow: number };
  dn: Fly["dn"]; motor: Fly["motor"]; speed: number; drift: number; courting: number;
}

/** where a fly was drawn at the last frame and where the new frame puts it */
interface Track { from: [number, number, number, number]; to: [number, number, number, number] }

const lerpAngle = (a: number, b: number, k: number) => a + (Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k);

export class LiveWorld {
  status: "connecting" | "live" | "reconnecting" | "failed" = "connecting";
  viewers = 0;
  puffs = 0;
  /** spikes of the watched fly, one array per simulation step, waiting to be drawn */
  readonly spikes: number[][] = [];
  private es: EventSource | null = null;
  private selectedId = -1;
  private tracks = new Map<number, Track>();
  private frameAt = 0;
  private lastMessage = 0;
  private drifts = new Map<number, number>();
  private dataTimer = 0;

  constructor(private world: World, private onFirstFrame: () => void) {
    this.connect();
    void this.fetchData();
    this.dataTimer = window.setInterval(() => void this.fetchData(), 20_000);
  }

  /** the watched fly's id, or -1 */
  get focus(): number { return this.selectedId; }

  close(): void {
    this.es?.close();
    this.es = null;
    clearInterval(this.dataTimer);
  }

  private connect(): void {
    this.es?.close();
    const es = new EventSource(`${LIVE_URL}/live?fly=${this.selectedId}`);
    this.es = es;
    es.addEventListener("full", (e) => this.onFull(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("frame", (e) => this.onFrame(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("brain", (e) => this.onBrain(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => { if (this.status === "live") this.status = "reconnecting"; };
  }

  /** Once per rendered frame: interpolate positions, age events, follow the user's pick. */
  update(wall: number): void {
    const w = this.world;
    if (this.status === "live" && performance.now() - this.lastMessage > 4000) this.status = "reconnecting";
    const k = Math.min(1, (performance.now() - this.frameAt) / FRAME_MS);
    for (const f of w.flies) {
      const t = this.tracks.get(f.id);
      if (t) {
        f.x = t.from[0] + (t.to[0] - t.from[0]) * k;
        f.y = t.from[1] + (t.to[1] - t.from[1]) * k;
        f.z = t.from[2] + (t.to[2] - t.from[2]) * k;
        f.yaw = lerpAngle(t.from[3], t.to[3], k);
      }
      f.wing += (6 + 48 * Math.max(0.05, f.motor.thrust + f.motor.jump)) * wall;
    }
    for (let i = w.events.length - 1; i >= 0; i--) {
      w.events[i].age += wall;
      if (w.events[i].age > 6) w.events.splice(i, 1);
    }
    this.followPick();
  }

  /** The user picked another fly (click, "next fly", drama cam): watch its brain instead. Checked before a frame
   *  reorders world.flies, so a pick made just before a frame arrives is not lost. */
  private followPick(): void {
    const w = this.world;
    const picked = w.flies[w.selected];
    if (picked && picked.id !== this.selectedId && this.status !== "connecting") {
      this.selectedId = picked.id;
      this.spikes.length = 0;
      this.connect();
    }
  }

  private onFull(m: Frame): void {
    const w = this.world;
    const first = this.status === "connecting";
    this.followPick();
    this.applyHeader(m);
    w.history = m.history as [number, number][];
    const listed = new Set(m.props.map((r) => r[0]));
    this.applyProps(m.props, w.props.filter((p) => !listed.has(p.id)).map((p) => p.id));
    this.applyFlies(m, true);
    if (m.focus !== undefined && m.focus >= 0 && (first || !w.flies.some((f) => f.id === this.selectedId))) this.selectedId = m.focus;
    this.select();
    this.status = "live";
    if (first) this.onFirstFrame();
  }

  private onFrame(m: Frame): void {
    const w = this.world;
    this.followPick();
    this.applyHeader(m);
    if (Array.isArray(m.history) && typeof m.history[0] === "number") {
      w.history.push(m.history as [number, number]);
      if (w.history.length > 300) w.history.shift();
    }
    this.applyProps(m.props, m.gone ?? []);
    this.applyFlies(m, false);
    for (const e of m.events ?? []) {
      w.events.push({ ...e });
      if (w.events.length > 40) w.events.shift();
    }
    this.select();
    this.status = "live";
  }

  private applyHeader(m: Header): void {
    const w = this.world;
    this.lastMessage = performance.now();
    w.steps = m.steps;
    w.timeOfDay = m.tod;
    Object.assign(w.wind, m.wind);
    w.matings = m.counts.matings; w.eggsLaid = m.counts.eggsLaid; w.hatched = m.counts.hatched; w.emerged = m.counts.emerged;
    Object.assign(w.deaths, m.counts.deaths);
    Object.assign(w.learning, m.learning);
    w.maxFlies = m.maxFlies;
    this.puffs = m.puffs;
    this.viewers = m.viewers;
    if (m.threat) {
      w.threat ??= { id: -1, kind: "threat", x: 0, y: 0, z: 0, radius: 3.4, open: 1, height: 5, shape: 0, species: 0, life: Infinity };
      [w.threat.x, w.threat.y, w.threat.z] = m.threat;
    } else {
      w.threat = null;
    }
  }

  private applyProps(rows: PropRow[], gone: number[]): void {
    const props = this.world.props;
    const byId = new Map(props.map((p) => [p.id, p]));
    for (const [id, kind, x, y, z, radius, open, height, shape, species] of rows) {
      const p = byId.get(id);
      // same object, new values: the renderer keeps its mesh, and rebuilds it if the kind changed (egg -> larva)
      if (p) Object.assign(p, { kind, x, y, z, radius, open, height, shape, species });
      else props.push({ id, kind, x, y, z, radius, open, height, shape, species, life: Infinity } as Prop);
    }
    if (gone.length) {
      const drop = new Set(gone);
      for (let i = props.length - 1; i >= 0; i--) if (drop.has(props[i].id)) props.splice(i, 1);
    }
  }

  private applyFlies(m: Frame, full: boolean): void {
    const w = this.world;
    // a fly this page has never seen needs a body; its brain here is only a display for what the server's brain did
    if (full && this.status === "connecting") w.flies.length = 0;
    const old = new Map(w.flies.map((f) => [f.id, f]));
    const details = new Map((m.details ?? []).map((d) => [d.id, d]));
    const next: Fly[] = [];
    for (const [id, x, y, z, yaw, state, flags, thrust, escape, jump] of m.flies) {
      let f = old.get(id);
      if (!f) {
        const d = details.get(id);
        f = new Fly(id, w.wiring, id, Math.max(0, NAMES.indexOf(d?.name ?? "")), founder(mulberry32(id)), d?.sex ?? "M");
        f.x = x; f.y = y; f.z = z; f.yaw = yaw;
        f.wing = id;
        // drift is measured on the server's synapses; this copy of the brain never learns
        const fid = id;
        f.brain.drift = () => this.drifts.get(fid) ?? 0;
      }
      const t = this.tracks.get(id);
      const drawn: [number, number, number, number] = t && !full ? [f.x, f.y, f.z, f.yaw] : [x, y, z, yaw];
      this.tracks.set(id, { from: drawn, to: [x, y, z, yaw] });
      f.state = STATES[state] ?? "FLYING";
      f.landed = (flags & 1) !== 0;
      f.feeding = (flags & 2) !== 0;
      f.motor.thrust = thrust; f.motor.jump = jump;
      f.dn.escape = escape;
      const d = details.get(id);
      if (d) this.applyDetail(f, d);
      next.push(f);
    }
    const alive = new Set(next.map((f) => f.id));
    for (const id of [...this.tracks.keys()]) if (!alive.has(id)) { this.tracks.delete(id); this.drifts.delete(id); }
    w.flies.length = 0;
    w.flies.push(...next);
    this.frameAt = performance.now();
    this.fillSeen();
  }

  private applyDetail(f: Fly, d: Detail): void {
    Object.assign(f, { name: d.name, sex: d.sex, generation: d.generation, mother: d.mother, father: d.father, age: d.age, mated: d.mated });
    Object.assign(f.stats, d.stats);
    // the parents' names, for "child of …" (the full lineage comes with /data)
    const lin = this.world.log.lineage;
    if (d.mother !== null && d.mother_name && !lin.has(d.mother)) lin.set(d.mother, { id: d.mother, name: d.mother_name });
    if (d.father !== null && d.father_name && !lin.has(d.father)) lin.set(d.father, { id: d.father, name: d.father_name });
  }

  private onBrain(m: BrainMsg): void {
    const w = this.world;
    const f = w.flies.find((x) => x.id === m.id);
    if (!f) return;
    if (m.id !== this.selectedId) {                         // the watched fly died and the server moved us on
      this.selectedId = m.id;
      this.select();
    }
    f.brain.rate.set(m.rate);
    Object.assign(f.vision.drive, m.vision);
    Object.assign(f.smell.drive, m.smell);
    f.mech.jo[0] = m.mech.jo[0]; f.mech.jo[1] = m.mech.jo[1];
    f.mech.leg[0] = m.mech.leg[0]; f.mech.leg[1] = m.mech.leg[1];
    f.mech.load[0] = m.mech.load[0]; f.mech.load[1] = m.mech.load[1];
    f.mech.taste = m.mech.taste; f.mech.flow = m.mech.flow;
    Object.assign(f.dn, m.dn);
    Object.assign(f.motor, m.motor);
    f.speed = m.speed;
    f.courting = m.courting;
    this.drifts.set(f.id, m.drift);
    for (const b64 of m.spikes) {
      const bits = atob(b64);
      const fired: number[] = [];
      for (let byte = 0; byte < bits.length; byte++) {
        const v = bits.charCodeAt(byte);
        if (v) for (let b = 0; b < 8; b++) if (v & (1 << b)) fired.push(byte * 8 + b);
      }
      this.spikes.push(fired);
    }
    if (this.spikes.length > 50) this.spikes.splice(0, this.spikes.length - 50);
  }

  /** point world.selected at the watched fly's current index */
  private select(): void {
    const w = this.world;
    const i = w.flies.findIndex((f) => f.id === this.selectedId);
    if (i >= 0) w.selected = i;
    else if (w.flies.length) { w.selected = Math.min(w.selected, w.flies.length - 1); }
  }

  /** what Wiz's eyes see (world.visible), since this world never steps */
  private fillSeen(): void {
    const w = this.world;
    const seen = (w as unknown as { seen: Seen[] }).seen;
    seen.length = 0;
    for (const p of w.props) {
      if (p.kind === "egg" || p.kind === "poop") continue;
      seen.push({ id: p.id, x: p.x, y: p.y, z: p.z, radius: p.radius, kind: p.kind });
    }
    if (w.threat) seen.push({ id: w.threat.id, x: w.threat.x, y: w.threat.y, z: w.threat.z, radius: w.threat.radius, kind: "threat" });
    for (const f of w.flies) seen.push({ id: f.id, x: f.x, y: f.y, z: f.z, radius: 0.36, kind: "fly" });
  }

  /** The Data card's charts: recent world rows, lineage, eggs and relationships, every 20 s. */
  private async fetchData(): Promise<void> {
    try {
      const res = await fetch(`${LIVE_URL}/data`);
      if (!res.ok) return;
      const d = await res.json() as { world: Row[]; lineage: Row[]; brood: Row[]; kin: Kin[]; pairs: PairStats[] };
      const w = this.world;
      w.log.world.rows = d.world;
      w.log.lineage.clear();
      for (const r of d.lineage) w.log.lineage.set(Number(r.id), r);
      w.log.brood.clear();
      for (const r of d.brood) w.log.brood.set(Number(r.id), r);
      w.kin.clear();
      for (const k of d.kin) w.kin.set(k.id, k);
      w.social.pairs.clear();
      for (const p of d.pairs) w.social.pairs.set(p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`, p);
    } catch { /* offline for a moment: keep what we have */ }
  }
}
