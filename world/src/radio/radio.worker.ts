/**
 * Fly Radio's brain, in the listener's browser: the real connectome (the same `flybrain export --web` files
 * the Simulation loads), one ConnectomeBrain per cast member of the show that's tuned in, each with its show's
 * fixed stimulus (flytalk.CONTEXTS) on every step. Paced to real time: one 100 ms chunk of 20 ms steps per
 * 100 ms of wall clock (slower if this device can't keep up). Nothing runs while the radio is off.
 *
 * in:  {type: "load", base}          base URL of the connectome files
 *      {type: "tune", show: id|null}  start a show from fresh brains, or stop
 * out: {type: "progress", text} · {type: "ready", n, nnz} · {type: "error", text}
 *      {type: "chunk", show, speaker, member, loud: Float32Array}  on-mic wing loudness per step
 *      {type: "caption", show, speaker, text, confidence, t}        decoded every 2 s of radio time
 *      {type: "perf", ms}                                          milliseconds per brain step
 */
import { ConnectomeBrain, cells, parseMeta, parseWeights, type ConnectomeMeta, type ConnectomeWeights } from "../connectome.ts";
import radio from "./radio.json";

const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

type Show = (typeof radio.shows)[number];
const CHUNK_STEPS = 5;                                   // 100 ms at dt 20 ms
const WARM_S = 0.5;                                      // settle before a show goes on air, like flytalk's warmup

/** One gzip stream in one or more parts (see connectome.worker.ts): join, then decompress if still gzipped. */
async function fetchGz(urls: string[], label: string, totalMb = 0): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let got = 0, lastReport = 0;
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (got - lastReport > 1_000_000) {
        lastReport = got;
        ctx.postMessage({ type: "progress", text: `${label} ${(got / 1e6).toFixed(0)}${totalMb ? ` / ${totalMb.toFixed(0)}` : ""} MB` });
      }
    }
  }
  const blob = new Blob(chunks as BlobPart[]);
  if (!(chunks[0]?.[0] === 0x1f && chunks[0]?.[1] === 0x8b)) return blob.arrayBuffer();
  return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

let meta: ConnectomeMeta | null = null;
let weights: ConnectomeWeights | null = null;
let isWing = new Uint8Array(0);
const contextCells = new Map<string, { idx: Int32Array; amount: number }[]>();

interface Member { name: string; brain: ConnectomeBrain; stim: { idx: Int32Array; amount: number }[]; hist: Float32Array; }
let show: Show | null = null;
let members: Member[] = [];
let generation = 0;
let simT = 0, speaker = 0, turnElapsed = 0, sinceCaption = 0, histAt = 0, warmLeft = 0;
let stepMs = 0;

function caption(loud: Float32Array): [string, number] {
  const { mu, P, sd, w, b } = radio.readout;
  const k = sd.length;
  const z = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    let s = 0;
    for (let f = 0; f < loud.length; f++) s += (loud[f] - mu[f]) * P[f][j];
    z[j] = s / sd[j];
  }
  const probs = w.map((row, c) => Math.max(0, row.reduce((acc, x, j) => acc + x * z[j], b[c])));
  const total = probs.reduce((a, x) => a + x, 0);
  const p = total > 0 ? probs.map((x) => x / total) : probs.map(() => 1 / probs.length);
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  return [radio.names[best], p[best]];
}

function start(id: string | null): void {
  generation++;
  show = id ? radio.shows.find((s) => s.id === id) ?? null : null;
  members = [];
  if (!show || !meta || !weights) return;
  const seed = (Date.now() & 0xffff) + 1;
  members = show.cast.map((m, i) => ({
    name: m.name,
    brain: new ConnectomeBrain(weights!, meta!.params, seed + 7919 * i),
    stim: contextCells.get(m.context) ?? [],
    hist: new Float32Array(radio.caption_steps),
  }));
  simT = 0; speaker = 0; turnElapsed = 0; sinceCaption = 0; histAt = 0;
  warmLeft = Math.round(WARM_S / radio.dt);
  loop(generation, performance.now());
}

function loop(gen: number, dueAt: number): void {
  if (gen !== generation || !show) return;
  const s = show;
  const t0 = performance.now();
  // settle every brain for half a second (no sound yet), then one chunk per tick
  const steps = warmLeft > 0 ? warmLeft : CHUNK_STEPS;
  const loud = members.map(() => new Float32Array(steps));
  for (let k = 0; k < steps; k++) {
    members.forEach((m, i) => {
      for (const p of m.stim) m.brain.stimulate(p.idx, p.amount);
      m.brain.step();
      let c = 0;
      for (let q = 0; q < m.brain.firedCount; q++) c += isWing[m.brain.fired[q]];
      const l = Math.max(0, c - radio.rest);
      loud[i][k] = l;
      if (warmLeft === 0) m.hist[(histAt + k) % m.hist.length] = l;
    });
  }
  const took = performance.now() - t0;
  stepMs += (took / (steps * Math.max(1, members.length)) - stepMs) * 0.2;
  if (warmLeft > 0) {
    warmLeft = 0;
    setTimeout(() => loop(gen, performance.now()), 0);
    return;
  }
  histAt = (histAt + steps) % radio.caption_steps;

  if (s.turn_seconds) {                                   // presenter / expert take turns on the mic
    turnElapsed += steps * radio.dt;
    if (turnElapsed >= s.turn_seconds[speaker]) { speaker = 1 - speaker; turnElapsed = 0; }
  }
  const on = s.turn_seconds ? speaker : 0;
  const chunk = loud[on];
  ctx.postMessage({ type: "chunk", show: s.id, speaker: members[on].name, member: on, loud: chunk }, [chunk.buffer]);

  simT += steps * radio.dt;
  sinceCaption += steps * radio.dt;
  if (sinceCaption >= radio.caption_every_s - 1e-9 && simT >= radio.caption_steps * radio.dt) {
    sinceCaption = 0;
    const m = members[on];
    const ordered = new Float32Array(m.hist.length);
    for (let k = 0; k < m.hist.length; k++) ordered[k] = m.hist[(histAt + k) % m.hist.length];
    const [text, confidence] = caption(ordered);
    ctx.postMessage({ type: "caption", show: s.id, speaker: m.name, text, confidence: Math.round(confidence * 1000) / 1000,
      t: Math.round(simT * 10) / 10 });
    ctx.postMessage({ type: "perf", ms: stepMs });
  }

  const next = dueAt + CHUNK_STEPS * radio.dt * 1000;
  const now = performance.now();
  // behind by more than half a second: this device is slower than real time, so stop trying to catch up
  const due = next < now - 500 ? now : next;
  setTimeout(() => loop(gen, due), Math.max(0, due - now));
}

async function load(base: string): Promise<void> {
  const res = await fetch(`${base}brain.json`);
  if (!res.ok) throw new Error(`${base}brain.json: HTTP ${res.status}`);
  const info: { parts: string[]; weights_mb: number } = await res.json();
  meta = parseMeta(await fetchGz([`${base}meta.bin`], "labels"));
  if (Math.abs(meta.params.dt - radio.dt) > 1e-9) throw new Error(`brain dt ${meta.params.dt} but radio expects ${radio.dt}`);
  const buf = await fetchGz(info.parts.map((p) => base + p), "fly brain", info.weights_mb);
  ctx.postMessage({ type: "progress", text: "wiring 25 M synapses" });
  weights = parseWeights(buf);
  isWing = new Uint8Array(meta.n);
  for (const side of ["L", "R"] as const) for (const i of cells(meta, radio.wing_mn, side)) isWing[i] = 1;
  for (const name of radio.names) {
    const parts = (radio.contexts as Record<string, { types: string[]; amount: number }[]>)[name];
    contextCells.set(name, parts.map((p) => ({ idx: cells(meta!, p.types), amount: p.amount })));
  }
  ctx.postMessage({ type: "ready", n: weights.n, nnz: weights.nnz });
}

let loading: Promise<void> | null = null;
let pending: string | null = null;

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "load" && !loading) {
    loading = load(msg.base).then(() => { if (pending) start(pending); })
      .catch((err) => ctx.postMessage({ type: "error", text: String(err) }));
  } else if (msg.type === "tune") {
    pending = msg.show;
    if (weights) start(msg.show);
    else if (!msg.show) start(null);
  }
};
