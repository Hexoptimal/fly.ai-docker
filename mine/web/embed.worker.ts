/**
 * Embedding jobs: one long-lived worker per model, so the model loads once (a 90-130 MB download the browser caches)
 * and every job after that is a fraction of a second on a GPU. transformers.js comes from jsDelivr at a pinned
 * version, and the model from the Hugging Face hub at the revision the server names, in fp32 on WebGPU where there is
 * one and on the WASM CPU backend otherwise. The two agree to a cosine of 0.9999995, which is what lets different
 * machines check each other's answers (src/orders.ts cosineAgree).
 *
 * in:  {type: "load", repo, revision, pooling}          → {type: "ready", device} · {type: "error", text}
 *      {type: "run", job, input, input_url, dim, output_bytes}  → {type: "done", job, output (base64 f32 LE)} · {type: "error", job, text}
 * A job's input (a JSON array of texts) is checked against its SHA-256 before it runs.
 */
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm";

const ctx = self as unknown as { postMessage(message: unknown): void; onmessage: ((e: MessageEvent) => void) | null };
let extract: ((texts: string[], options: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>) | null = null;
let pooling = "mean";

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** WebGPU if this worker can get an adapter, else the CPU. */
async function device(): Promise<"webgpu" | "wasm"> {
  const gpu = (self.navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return "wasm";
  try {
    return (await gpu.requestAdapter({ powerPreference: "high-performance" })) ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

async function load(m: { repo: string; revision: string; pooling: string }): Promise<string> {
  const lib = await import(TRANSFORMERS);
  lib.env.allowLocalModels = false;
  pooling = m.pooling;
  const first = await device();
  for (const dev of first === "webgpu" ? ["webgpu", "wasm"] : ["wasm"]) {
    try {
      extract = await lib.pipeline("feature-extraction", m.repo, { device: dev, dtype: "fp32", revision: m.revision });
      return dev;
    } catch (err) {
      if (dev === "wasm") throw err; // a GPU that fails to set up falls back to the CPU
    }
  }
  throw new Error("no backend could load the model");
}

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "load") {
    load(m).then((dev) => ctx.postMessage({ type: "ready", device: dev }), (err) => ctx.postMessage({ type: "error", text: String(err).slice(0, 300) }));
    return;
  }
  if (m.type !== "run") return;
  void (async () => {
    try {
      if (!extract) throw new Error("the model isn't loaded");
      const res = await fetch(m.input_url);
      if (!res.ok) throw new Error(`couldn't fetch the input: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== m.input) throw new Error("the input doesn't match its hash");
      const texts = JSON.parse(new TextDecoder().decode(bytes)) as string[];
      const out = await extract(texts, { pooling, normalize: true });
      const vectors = new Float32Array(out.data); // a copy: the tensor's buffer may be bigger than its data
      if (vectors.byteLength !== m.output_bytes || out.dims[1] !== m.dim) throw new Error(`the model gave ${out.dims.join("x")}, expected ${texts.length}x${m.dim}`);
      ctx.postMessage({ type: "done", job: m.job, output: base64(new Uint8Array(vectors.buffer)) });
    } catch (err) {
      ctx.postMessage({ type: "error", job: m.job, text: String(err).slice(0, 300) });
    }
  })();
};
