/**
 * The GPU mining thread: downloads the connectome, uploads it to the GPU, then runs batches of jobs.
 *
 * in:  {type: "load", fixed, brains, connectome}  ·  {type: "run", batch, tasks}
 * out: {type: "progress", text} · {type: "ready", adapter, brains} · {type: "step", batch, step, steps}
 *      {type: "done", batch, results} · {type: "error", batch?, text}
 */
import { GpuBrains } from "./gpu.ts";
import { downloadModel } from "./download.ts";

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let gpu: GpuBrains | null = null;

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "load") {
    const report = (text: string) => ctx.postMessage({ type: "progress", text });
    downloadModel(report, msg.connectome)
      .then((model) => {
        report("uploading to the GPU");
        return GpuBrains.create(model, msg.fixed, msg.brains);
      })
      .then((g) => {
        gpu = g;
        ctx.postMessage({ type: "ready", adapter: g.adapterName, brains: g.maxBrains });
      })
      .catch((err) => ctx.postMessage({ type: "error", text: String(err) }));
  } else if (msg.type === "run") {
    if (!gpu) return ctx.postMessage({ type: "error", batch: msg.batch, text: "GPU not ready" });
    gpu.run(msg.tasks, (step, steps) => ctx.postMessage({ type: "step", batch: msg.batch, step, steps }))
      .then((results) => ctx.postMessage({ type: "done", batch: msg.batch, results }))
      .catch((err) => ctx.postMessage({ type: "error", batch: msg.batch, text: String(err) }));
  }
};
