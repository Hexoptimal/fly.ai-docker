/**
 * What every mining thread starts with: the connectome files and the server's engine constants.
 * `connectome` is where the brain files are (the Simulation's copy on the website); `server` is the API origin.
 */
import type { Fixed } from "../src/fixed.ts";
import { buildModel, type Model } from "../src/model.ts";

/**
 * Join the parts and decompress unless the server already did, as world/src/connectome.worker.ts.
 * A part is retried from the start if the stream breaks: Chrome fails one of two readers that hit the
 * same large file while its cache entry is still being written.
 */
async function fetchGz(urls: string[], label: string, report: (text: string) => void): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let got = 0;
  let lastReport = 0;
  for (const url of urls) {
    for (let attempt = 1; ; attempt++) {
      const part: Uint8Array[] = [];
      let partBytes = 0;
      try {
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          part.push(value);
          partBytes += value.length;
          if (got + partBytes - lastReport > 2_000_000) {
            lastReport = got + partBytes;
            report(`downloading ${label}: ${(lastReport / 1e6).toFixed(0)} MB`);
          }
        }
      } catch (err) {
        if (attempt === 3) throw err;
        report(`download interrupted, retrying ${label}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      chunks.push(...part);
      got += partBytes;
      break;
    }
  }
  const blob = new Blob(chunks as BlobPart[]);
  if (!(chunks[0]?.[0] === 0x1f && chunks[0]?.[1] === 0x8b)) return blob.arrayBuffer();
  return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

export async function downloadModel(report: (text: string) => void, connectome: string): Promise<Model> {
  const res = await fetch(`${connectome}/brain.json`);
  if (!res.ok) throw new Error(`brain.json: HTTP ${res.status}`);
  const info: { parts: string[] } = await res.json();
  const meta = await fetchGz([`${connectome}/meta.bin`], "labels", report);
  const weights = await fetchGz(info.parts.map((p) => `${connectome}/${p}`), "connectome", report);
  report("wiring 25 M synapses");
  return buildModel(meta, weights);
}

export interface ModelInfo { fixed: Fixed; outputs: string[] }

/** GET /api/model, with the weight table decoded. */
export async function fetchModelInfo(server = ""): Promise<ModelInfo> {
  const res = await fetch(`${server}/api/model`);
  const m = await res.json();
  if (!res.ok) throw new Error(m.error ?? `HTTP ${res.status}`);
  const bytes = Uint8Array.from(atob(m.w20), (c) => c.charCodeAt(0));
  return {
    fixed: { w20: new Int32Array(bytes.buffer), decay: m.decay, noiseThresh: m.noise_thresh, noiseAmp: m.noise_amp },
    outputs: m.outputs,
  };
}
