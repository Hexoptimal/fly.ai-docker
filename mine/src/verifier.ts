/**
 * Worker thread that owns the server's copy of the connectome: it fixes the engine constants every miner
 * gets, and re-runs jobs on the CPU to check miners' answers (GPU miners' included; the results are identical).
 *
 * in:  {type: "run", task, params}
 * out: {type: "ready", fixed, outputs, outputSizes, dt} · {type: "done", task, result} · {type: "error", task, text}
 */
import { parentPort, workerData } from "node:worker_threads";
import { fixedFrom } from "./fixed.ts";
import { loadModel } from "./load.ts";
import { runTask, type TaskParams } from "./runner.ts";

const port = parentPort!;
const model = loadModel(workerData.dir as string);
const fixed = fixedFrom(model.w.lut, model.meta.params);
port.postMessage({ type: "ready", fixed, outputs: model.outputs, outputSizes: model.outputSizes, dt: model.meta.params.dt });

port.on("message", (msg: { type: "run"; task: number; params: TaskParams }) => {
  try {
    port.postMessage({ type: "done", task: msg.task, result: runTask(model, fixed, msg.params) });
  } catch (err) {
    port.postMessage({ type: "error", task: msg.task, text: String(err) });
  }
});
