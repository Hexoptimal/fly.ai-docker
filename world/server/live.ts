// The live feed: every visitor of the page watches this one world instead of running their own (src/live.ts).
//
//   GET /live?fly=<id>   Server-Sent Events. First a "full" frame (every fly, every prop, the population history),
//                        then a frame every FRAME_MS: fly positions and states, props that changed or went, new events,
//                        and the focused fly's brain (rates, sense drives, the spikes of every step since the last frame).
//                        Once a second the frame also carries the slower fly details (age, parents, scoreboard).
//                        Switching fly means reconnecting with another ?fly=.
//   GET /data            what the Data card charts: recent world rows, lineage, eggs, kin and relationships.
//
// Frames are built once per tick and shared by every client; the per-fly brain part once per focused fly. Each stream
// is gzipped (the keys repeat every frame), spikes go as one base64 bitset per step, and a client that cannot keep up
// is dropped rather than buffered without end (EventSource reconnects on its own).
import type { IncomingMessage, ServerResponse } from "node:http";
import { constants, createGzip, gzipSync, type Gzip } from "node:zlib";
import type { Fly, Prop, World, WorldEvent } from "../src/sim.ts";

export const FRAME_MS = 100;
const DETAIL_EVERY = 10;                                   // slow fly details every 10 frames (1 s)
const STATES = ["PANIC", "SURGING", "CASTING", "FEEDING", "LANDED", "TAKE-OFF", "FLYING"];

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

interface Client { res: ServerResponse; zip: Gzip | null; focus: number }

const BACKLOG = 1 << 20;                                   // bytes queued for one client before it is dropped

const propRow = (p: Prop) => [p.id, p.kind, r2(p.x), r2(p.y), r2(p.z), r3(p.radius), r2(p.open), r2(p.height), r3(p.shape), p.species];

/** fast-changing, every frame: id, x, y, z, yaw, state, landed|feeding bits, DLM thrust, giant fibre, jump */
const flyRow = (f: Fly) => [f.id, r2(f.x), r2(f.y), r2(f.z), r2(f.yaw), STATES.indexOf(f.state), (f.landed ? 1 : 0) | (f.feeding ? 2 : 0),
  r2(f.motor.thrust), r2(f.dn.escape), r2(f.motor.jump)];

/** slow, once a second */
const flyDetail = (w: World, f: Fly) => ({
  id: f.id, name: f.name, sex: f.sex, generation: f.generation, mother: f.mother, father: f.father,
  mother_name: f.mother !== null ? w.log.lineage.get(f.mother)?.name ?? null : null,
  father_name: f.father !== null ? w.log.lineage.get(f.father)?.name ?? null : null,
  age: r1(f.age), mated: f.mated, stats: { fed: f.stats.fed, distance: r1(f.stats.distance), panics: f.stats.panics, swatted: f.stats.swatted },
});

export class LiveHub {
  private clients = new Set<Client>();
  private sentProps = new Map<number, string>();
  private sentEvents = new WeakSet<WorldEvent>();
  private spikes = new Map<number, string[]>();            // focused fly id -> one bitset per step since the last frame
  private frames = 0;
  readonly maxClients: number;
  private readonly world: () => World;

  constructor(world: () => World, maxClients: number) {
    this.world = world;
    this.maxClients = maxClients;
    setInterval(() => this.tick(), FRAME_MS);
    setInterval(() => { for (const c of this.clients) this.write(c, ": ping\n\n"); }, 15_000);
  }

  get count(): number { return this.clients.size; }

  /** Call after every world.step(): keeps the spikes of the flies someone is watching. */
  afterStep(): void {
    if (!this.spikes.size) return;
    for (const f of this.world().flies) {
      const buf = this.spikes.get(f.id);
      if (!buf) continue;
      const bits = Buffer.alloc((f.brain.w.n + 7) >> 3);
      for (let k = 0; k < f.brain.firedCount; k++) { const i = f.brain.fired[k]; bits[i >> 3] |= 1 << (i & 7); }
      buf.push(bits.toString("base64"));
      if (buf.length > 50) buf.shift();
    }
  }

  connect(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.clients.size >= this.maxClients) { res.writeHead(503, { "Content-Type": "text/plain" }); res.end("full"); return; }
    const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no",
      ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    });
    let zip: Gzip | null = null;
    if (gzip) {
      zip = createGzip({ level: 4, memLevel: 7 });
      zip.pipe(res);
      zip.on("error", () => res.destroy());
    }
    const w = this.world();
    const want = Number(url.searchParams.get("fly"));
    const focus = w.flies.some((f) => f.id === want) ? want : w.flies[0]?.id ?? -1;
    const client: Client = { res, zip, focus };
    this.clients.add(client);
    if (!this.spikes.has(focus)) this.spikes.set(focus, []);
    this.write(client, "retry: 2000\n\n");
    this.send(client, "full", JSON.stringify({
      ...this.header(w), focus,
      flies: w.flies.map(flyRow), details: w.flies.map((f) => flyDetail(w, f)),
      props: w.props.map(propRow), history: w.history,
    }));
    req.on("close", () => {
      zip?.end();
      this.clients.delete(client);
      if (![...this.clients].some((c) => c.focus === client.focus)) this.spikes.delete(client.focus);
    });
  }

  private header(w: World) {
    const t = w.threat;
    return {
      steps: w.steps, tod: r3(w.timeOfDay), wind: { angle: r3(w.wind.angle), strength: r2(w.wind.strength) },
      threat: t ? [r2(t.x), r2(t.y), r2(t.z)] : null,
      counts: { matings: w.matings, eggsLaid: w.eggsLaid, hatched: w.hatched, emerged: w.emerged, deaths: w.deaths },
      puffs: w.field.puffCount, maxFlies: w.maxFlies, learning: w.learning, viewers: this.clients.size,
    };
  }

  private send(c: Client, event: string, data: string): void {
    this.write(c, `event: ${event}\ndata: ${data}\n\n`);
  }

  private write(c: Client, text: string): void {
    if (c.res.writableLength + (c.zip?.writableLength ?? 0) > BACKLOG) { c.res.destroy(); return; }
    if (c.zip) {
      c.zip.write(text);
      c.zip.flush(constants.Z_SYNC_FLUSH);
    } else {
      c.res.write(text);
    }
  }

  private tick(): void {
    const w = this.world();
    // props: what changed since the last frame, and what went (the full frame gives newcomers the rest)
    const changed: unknown[] = [];
    const live = new Set<number>();
    for (const p of w.props) {
      live.add(p.id);
      const row = propRow(p);
      const key = row.join(",");
      if (this.sentProps.get(p.id) !== key) { this.sentProps.set(p.id, key); changed.push(row); }
    }
    const gone: number[] = [];
    for (const id of this.sentProps.keys()) if (!live.has(id)) { this.sentProps.delete(id); gone.push(id); }
    const events = w.events.filter((e) => !this.sentEvents.has(e));
    for (const e of events) this.sentEvents.add(e);
    this.frames++;
    if (!this.clients.size) return;

    const slow = this.frames % DETAIL_EVERY === 0;
    const frame = JSON.stringify({
      ...this.header(w), flies: w.flies.map(flyRow), props: changed, gone,
      events: events.map((e) => ({ kind: e.kind, text: e.text, x: r2(e.x), y: r2(e.y), z: r2(e.z), age: r2(e.age) })),
      details: slow ? w.flies.map((f) => flyDetail(w, f)) : undefined,
      history: slow ? w.history.at(-1) : undefined,
    });
    const byId = new Map(w.flies.map((f) => [f.id, f]));
    const brains = new Map<number, string>();
    for (const c of this.clients) {
      if (!byId.has(c.focus)) {
        // the fly this client watched died: move them on to someone alive, like the local page does
        this.spikes.delete(c.focus);
        c.focus = w.flies[0]?.id ?? -1;
        if (!this.spikes.has(c.focus)) this.spikes.set(c.focus, []);
      }
      this.send(c, "frame", frame);
      let brain = brains.get(c.focus);
      if (brain === undefined) {
        const f = byId.get(c.focus);
        brain = f ? JSON.stringify(this.brain(f)) : "";
        brains.set(c.focus, brain);
      }
      if (brain) this.send(c, "brain", brain);
    }
    for (const id of brains.keys()) { const buf = this.spikes.get(id); if (buf) buf.length = 0; }
  }

  private brain(f: Fly) {
    const smell: Record<string, [number, number]> = {};
    for (const [k, [l, r]] of Object.entries(f.smell.drive)) smell[k] = [r3(l), r3(r)];
    return {
      id: f.id, rate: Array.from(f.brain.rate, r1), spikes: this.spikes.get(f.id) ?? [],
      vision: Object.fromEntries(Object.entries(f.vision.drive).map(([k, v]) => [k, r3(v)])), smell,
      mech: { jo: f.mech.jo.map(r3), leg: f.mech.leg.map(r3), load: f.mech.load.map(r3), taste: r3(f.mech.taste), flow: r3(f.mech.flow) },
      dn: { turn: r3(f.dn.turn), thrust: r3(f.dn.thrust), back: r3(f.dn.back), escape: r3(f.dn.escape) },
      motor: { turn: r3(f.motor.turn), thrust: r3(f.motor.thrust), back: r3(f.motor.back), jump: r3(f.motor.jump) },
      speed: r2(f.speed), drift: Math.round(f.brain.drift() * 1e5) / 1e5, courting: r1(f.courting),
    };
  }
}

/** GET /data: the Data card's inputs, gzipped when the browser accepts it. */
export function sendData(req: IncomingMessage, res: ServerResponse, w: World): void {
  const body = JSON.stringify({
    t: w.time, learning: w.learning,
    world: w.log.world.rows.slice(-600),
    lineage: [...w.log.lineage.values()], brood: [...w.log.brood.values()],
    kin: [...w.kin.values()], pairs: [...w.social.pairs.values()],
  });
  if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "no-cache" });
    res.end(gzipSync(body));
  } else {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(body);
  }
}
