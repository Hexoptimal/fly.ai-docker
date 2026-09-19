/**
 * Fly Roulette's brains, in the player's browser: the real connectome (the Simulation's files), one
 * ConnectomeBrain per fly at the table, kept between turns. On its turn a fly stares at the toy gun, feels the
 * trigger, and we count its wing-power and leg-flexor spikes (readout.ts). Steps are streamed so the page can
 * show the brain deciding.
 *
 * in:  {type: "load", base} · {type: "table", seeds: number[]} · {type: "turn", fly, chamber}
 * out: {type: "progress", text} · {type: "ready", n} · {type: "error", text}
 *      {type: "step", fly, wing, grip, gf, t}   running totals while it decides
 *      {type: "decided", fly, choice, wing, grip, gf}
 */
import { ConnectomeBrain, cells, parseMeta, parseWeights, type ConnectomeMeta, type ConnectomeWeights } from "../connectome.ts";
import { groups, runTurn } from "./readout.ts";

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

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
let g: ReturnType<typeof groups> | null = null;
let brains: ConnectomeBrain[] = [];
let seeds: number[] = [];

async function load(base: string): Promise<void> {
  const res = await fetch(`${base}brain.json`);
  if (!res.ok) throw new Error(`${base}brain.json: HTTP ${res.status}`);
  const info: { parts: string[]; weights_mb: number } = await res.json();
  meta = parseMeta(await fetchGz([`${base}meta.bin`], "labels"));
  const buf = await fetchGz(info.parts.map((p) => base + p), "fly brain", info.weights_mb);
  ctx.postMessage({ type: "progress", text: "wiring 25 M synapses" });
  weights = parseWeights(buf);
  g = groups(meta, cells);
  ctx.postMessage({ type: "ready", n: weights.n });
}

/** A fresh brain per seat, made when the fly first needs it. */
function brainOf(fly: number): ConnectomeBrain {
  if (!brains[fly]) brains[fly] = new ConnectomeBrain(weights!, meta!.params, seeds[fly] ?? fly + 1);
  return brains[fly];
}

function turn(fly: number, chamber: number): void {
  const c = runTurn(brainOf(fly), g!, chamber, (n, t) => ctx.postMessage({ type: "step", fly, ...n, t }));
  ctx.postMessage({ type: "decided", fly, ...c });
}

let loading: Promise<void> | null = null;
ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "load" && !loading) {
    loading = load(msg.base).catch((err) => ctx.postMessage({ type: "error", text: String(err) }));
  } else if (msg.type === "table") {
    seeds = msg.seeds;
    brains = [];
  } else if (msg.type === "turn") {
    void loading?.then(() => { if (weights) turn(msg.fly, msg.chamber); });
  }
};
