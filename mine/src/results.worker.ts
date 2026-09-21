/**
 * GET /api/results, worked out off the main thread. Averaging every done screen job over seeds reads ~2M rows;
 * on 2026-09-21 that took 63 s on the main thread and, polled once a minute, froze the whole server (miners,
 * pages and the health check) most of the time. Here it reads its own read-only connection, streams the rows
 * instead of loading them all, posts the summary and exits.
 *
 * in:  workerData {db, outputs, outputSizes, dt}
 * out: {units, outputs, rows}
 */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { TaskParams, TaskResult } from "./runner.ts";

const { outputs, outputSizes, dt } = workerData as { db: string; outputs: string[]; outputSizes: number[]; dt: number };
const db = new DatabaseSync(workerData.db, { readOnly: true });
const rows = db.prepare(`
  select t.params, t.truth is not null as checked, coalesce(t.truth, (
    select a.result from assignments a join miners m on m.id = a.miner
    where a.task = t.id and (a.status = 'accepted' or (a.status = 'pending' and m.strikes = 0)) limit 1)) as result
  from tasks t where t.state = 'done' and t.kind = 'connectome'`).iterate() as Iterable<{ params: string; checked: number; result: string | null }>;

type Cell = { params: Omit<TaskParams, "seed">; seeds: number; checked: number; base: number[]; stim: number[] };
const cells = new Map<string, Cell>();
for (const row of rows) {
  if (!row.result) continue;
  const { seed: _seed, ...params } = JSON.parse(row.params) as TaskParams;
  const r = JSON.parse(row.result) as TaskResult;
  const key = JSON.stringify(params);
  const c = cells.get(key) ?? { params, seeds: 0, checked: 0, base: outputs.map(() => 0), stim: outputs.map(() => 0) };
  c.seeds++;
  c.checked += row.checked;
  r.base.forEach((n, g) => { c.base[g] += n / (outputSizes[g] || 1) / (params.warm * dt); });
  r.stim.forEach((n, g) => { c.stim[g] += n / (outputSizes[g] || 1) / ((params.steps - params.warm) * dt); });
  cells.set(key, c);
}
db.close();

const round2 = (x: number) => Math.round(x * 100) / 100;
parentPort!.postMessage({
  units: "spikes per neuron per second, mean over seeds",
  outputs,
  rows: [...cells.values()].map((c) => ({
    ...c.params, seeds: c.seeds, checked_seeds: c.checked,
    base_hz: c.base.map((x) => round2(x / c.seeds)), stim_hz: c.stim.map((x) => round2(x / c.seeds)),
  })),
});
