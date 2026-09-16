/**
 * One CPU mining thread: downloads the connectome once, then runs whatever job the page hands it.
 *
 * in:  {type: "load", fixed, connectome}  ·  {type: "run", job, params}
 * out: {type: "progress", text} · {type: "ready"} · {type: "step", job, step, steps} · {type: "done", job, result}
 *      {type: "error", job?, text}
 */
import type { Fixed } from "../src/fixed.ts";
import type { Model } from "../src/model.ts";
import { runProbe } from "../src/probe.ts";
import { runTask, type TaskParams } from "../src/runner.ts";
import { downloadModel } from "./download.ts";

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let model: Model | null = null;
let fixed: Fixed | null = null;

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "load") {
    fixed = msg.fixed;
    downloadModel((text) => ctx.postMessage({ type: "progress", text }), msg.connectome)
      .then((m) => {
        model = m;
        ctx.postMessage({ type: "ready" });
      })
      .catch((err) => ctx.postMessage({ type: "error", text: String(err) }));
  } else if (msg.type === "probe") {
    // a house probe on this thread's loaded connectome: answer {output: base64} or {error}
    if (!model || !fixed) return ctx.postMessage({ type: "error", job: msg.job, text: "connectome not loaded" });
    let result: { output: string } | { error: string };
    try {
      const bytes = runProbe(model, fixed, msg.params);
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      result = { output: btoa(s) };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    ctx.postMessage({ type: "done", job: msg.job, result });
  } else if (msg.type === "run") {
    if (!model || !fixed) return ctx.postMessage({ type: "error", job: msg.job, text: "connectome not loaded" });
    const params: TaskParams = msg.params;
    try {
      const result = runTask(model, fixed, params, (step) => ctx.postMessage({ type: "step", job: msg.job, step, steps: params.steps }));
      ctx.postMessage({ type: "done", job: msg.job, result });
    } catch (err) {
      ctx.postMessage({ type: "error", job: msg.job, text: String(err) });
    }
  }
};
