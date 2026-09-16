/**
 * Mining without a page: claim -> run -> submit on the GPU (a batch at a time) or N CPU threads, reporting
 * through hooks. The website (web/app.ts) and the browser extension (extension/offscreen.ts) both drive it.
 *
 * With `programs` on, lanes also take buyers' programs: WASM on any lane, WGSL shaders on the GPU lane. Each one
 * runs in its own fresh worker (web/open.worker.ts), which is terminated at the job's time limit.
 */
import type { Fixed } from "../src/fixed.ts";
import type { TaskParams, TaskResult } from "../src/runner.ts";
import { fetchModelInfo } from "./download.ts";

export interface MineSettings {
  engine: "gpu" | "cpu";
  /** GPU: jobs per batch */
  batch: number;
  /** CPU: worker threads */
  threads: number;
  /** also run buyers' programs (sandboxed); default true */
  programs?: boolean;
}

export interface MinerHooks {
  /** the mining server's origin; "" for same-origin */
  server: string;
  /** base URL of the brain files (brain.json, meta.bin, weights.*.bin) */
  connectome: string;
  getToken(): string | null;
  setToken(token: string | null): void;
  /** optional name stored with a new miner */
  label(): string;
  status(text: string): void;
  /** one lane per GPU or CPU thread */
  lanes(names: string[]): void;
  lane(index: number, text: string, progress?: number): void;
  job(text: string): void;
  session(s: { jobs: number; units: number; perMinute: number }): void;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api(server: string, path: string, token: string | null, body?: unknown): Promise<any> {
  const res = await fetch(server + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface GpuProbe {
  /** a WebGPU adapter with buffers big enough for the connectome */
  usable: boolean;
  name: string;
  /** why it can't be used, when it can't */
  reason?: string;
}

/** The connectome's wiring is one ~100 MB storage buffer. */
const WIRING_BYTES = 100_352_428;

/** What WebGPU exposes here, and whether mining can use it. */
export async function probeGpu(): Promise<GpuProbe> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return { usable: false, name: "none", reason: "this browser has no WebGPU" };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { usable: false, name: "none", reason: "WebGPU found no GPU (blocklisted driver or disabled hardware acceleration)" };
    const info = adapter.info;
    const name = [info.vendor, info.architecture, info.description || info.device].filter(Boolean).join(" · ") || "GPU";
    if (adapter.limits.maxStorageBufferBindingSize < WIRING_BYTES) {
      return { usable: false, name, reason: `buffers up to ${Math.round(adapter.limits.maxStorageBufferBindingSize / 1e6)} MB; the connectome needs 100 MB` };
    }
    return { usable: true, name };
  } catch (err) {
    return { usable: false, name: "none", reason: String(err) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const describeJob = (p: TaskParams) => p.channel === "none"
  ? `control: no drive · gain ${p.gain} · tonic ${p.tonic}`
  : `${p.channel} ${p.side === "L" ? "left" : "right"} at ${p.amount} · gain ${p.gain} · tonic ${p.tonic}`;

interface ProgramParams {
  kind: "wasm" | "wgsl"; program: string; program_url: string; input: string | null; input_url: string | null; index: number;
  timeout_s: number; max_output: number; dispatch: [number, number, number] | null; output_bytes: number | null;
}
interface Claimed { job: string; kind?: string; params: TaskParams; units?: number }
interface ProgramClaim { job: string; kind: "wasm" | "wgsl" | "world"; params: ProgramParams; units?: number }
interface ProbeClaim { job: string; kind: "probe"; params: Record<string, unknown> & { timeout_s: number; condition: string }; units?: number }

const describeClaim = (j: Claimed | ProgramClaim | ProbeClaim) => (j.kind === "wasm" || j.kind === "wgsl"
  ? `a buyer's ${j.kind === "wasm" ? "WASM program" : "GPU shader"}, job #${(j.params as ProgramParams).index}`
  : j.kind === "world" ? `a world simulation, seed ${(j.params as unknown as { seed: number }).seed}`
  : j.kind === "probe" ? `a brain probe: ${(j.params as { condition: string }).condition}`
  : describeJob(j.params as TaskParams));

/**
 * One program job in a throwaway worker. Resolves to the answer to submit, or null when this machine couldn't run it
 * (then nothing is submitted and the job goes back out).
 */
function runProgram(server: string, job: ProgramClaim): Promise<{ output: string } | { error: string } | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./open.worker.ts", import.meta.url), { type: "module" });
    const origin = server || location.origin;
    const done = (answer: { output: string } | { error: string } | null) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(answer);
    };
    const timer = setTimeout(() => done({ error: "timeout" }), job.params.timeout_s * 1000);
    worker.onerror = () => done(null);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "done") done({ output: m.output });
      else if (m.type === "failed") done({ error: m.error });
      else done(null);
    };
    worker.postMessage(job.kind === "world"
      ? { type: "run", ...job.params }
      : { type: "run", ...job.params, program_url: origin + job.params.program_url, input_url: job.params.input_url && origin + job.params.input_url });
  });
}

interface Lane {
  worker: Worker;
  size: number;
  index: number;
  /** job kinds this lane asks for, and how many programs a claim may include */
  kinds: string[];
  openMax: number;
  run(jobs: Claimed[]): Promise<TaskResult[]>;
  /** CPU lanes: a probe on this thread's loaded connectome */
  probe?(params: Record<string, unknown>): Promise<{ output: string } | { error: string }>;
}

export class Miner {
  private hooks: MinerHooks;
  private lanes: Lane[] = [];
  /** bumped by every start and stop, so a stale loop notices it's been replaced */
  private generation = 0;
  private session = { jobs: 0, units: 0, since: 0 };

  constructor(hooks: MinerHooks) {
    this.hooks = hooks;
  }

  get running(): boolean {
    return this.lanes.length > 0 || this.starting;
  }
  private starting = false;

  async start(s: MineSettings): Promise<void> {
    this.stop("");
    const gen = ++this.generation;
    const h = this.hooks;
    this.starting = true;
    try {
      h.status("registering");
      await this.ensureMiner();
      h.status("fetching the engine constants");
      const { fixed } = await fetchModelInfo(h.server);
      if (gen !== this.generation) return;
      if (s.engine === "gpu") {
        h.lanes(["GPU"]);
        h.status("loading the connectome onto the GPU (57 MB download, once)");
        this.lanes = [await this.spawn("gpu", 0, fixed, s.batch, gen)];
        if (s.programs !== false) Object.assign(this.lanes[0], { kinds: ["connectome", "wgsl", "wasm", "world"], openMax: 2 });
      } else {
        const n = Math.max(1, s.threads);
        h.lanes(Array.from({ length: n }, (_, i) => `thread ${i + 1}`));
        h.status(`loading the connectome into ${n} thread${n > 1 ? "s" : ""} (57 MB download, once)`);
        // the first thread fills the browser cache; the rest then read from it instead of racing the download
        const first = await this.spawn("cpu", 0, fixed, 1, gen);
        this.lanes = [first];
        const rest = await Promise.all(Array.from({ length: n - 1 }, (_, i) => this.spawn("cpu", i + 1, fixed, 1, gen)));
        this.lanes.push(...rest);
        if (s.programs !== false) for (const lane of this.lanes) Object.assign(lane, { kinds: ["connectome", "wasm", "world", "probe"], openMax: 1 });
      }
      if (gen !== this.generation) return;
      this.starting = false;
      h.status("mining");
      this.session = { jobs: 0, units: 0, since: performance.now() };
      await Promise.all(this.lanes.map((lane) => this.loop(lane, gen)));
    } catch (err) {
      if (gen === this.generation) this.stop(`stopped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (gen === this.generation) this.starting = false;
    }
  }

  stop(status = "stopped"): void {
    this.generation++;
    this.starting = false;
    for (const lane of this.lanes) lane.worker.terminate();
    this.lanes = [];
    this.hooks.lanes([]);
    this.hooks.job("—");
    if (status) this.hooks.status(status);
  }

  private async ensureMiner(): Promise<void> {
    if (this.hooks.getToken()) return;
    const { token } = await api(this.hooks.server, "/api/register", null, { label: this.hooks.label() });
    this.hooks.setToken(token);
  }

  /** Start a worker and wait for it to load the connectome. */
  private spawn(kind: "gpu" | "cpu", index: number, fixed: Fixed, size: number, gen: number): Promise<Lane> {
    const h = this.hooks;
    const worker = new Worker(new URL(kind === "gpu" ? "./gpu.worker.ts" : "./miner.worker.ts", import.meta.url), { type: "module" });
    if (gen !== this.generation) worker.terminate();
    let seq = 0;
    const callProbe = (params: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
      const id = String(++seq);
      worker.onerror = (e) => reject(new Error(e.message || "mining thread crashed"));
      worker.onmessage = (e) => {
        if (e.data.job !== id) return;
        if (e.data.type === "done") resolve(e.data.result);
        else if (e.data.type === "error") reject(new Error(e.data.text));
      };
      worker.postMessage({ type: "probe", job: id, params });
    });
    const call = (msg: Record<string, unknown>, key: string): Promise<any> => new Promise((resolve, reject) => {
      const id = String(++seq);
      worker.onerror = (e) => reject(new Error(e.message || "mining thread crashed"));
      worker.onmessage = (e) => {
        const m = e.data;
        if (m[key] !== id) return;
        if (m.type === "step") h.lane(index, `${Math.round((100 * m.step) / m.steps)}%`, m.step / m.steps);
        else if (m.type === "done") resolve(m.results ?? m.result);
        else if (m.type === "error") reject(new Error(m.text));
      };
      worker.postMessage({ type: "run", [key]: id, ...msg });
    });
    const lane: Lane = {
      worker, size, index, kinds: ["connectome"], openMax: 0,
      run: kind === "gpu"
        ? (jobs) => call({ tasks: jobs.map((j) => j.params) }, "batch")
        : async (jobs) => [await call({ params: jobs[0].params }, "job")],
      ...(kind === "cpu" ? { probe: (params: Record<string, unknown>) => callProbe(params) } : {}),
    };
    return new Promise((resolve, reject) => {
      // a worker script that fails to load or parse only reports here, never through onmessage
      worker.onerror = (e) => reject(new Error(e.message || "mining thread failed to start"));
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "progress") h.lane(index, m.text);
        else if (m.type === "ready") {
          h.lane(index, kind === "gpu" ? `ready · ${m.adapter}` : "ready", 0);
          resolve(lane);
        } else if (m.type === "error") reject(new Error(m.text));
      };
      worker.postMessage(kind === "gpu" ? { type: "load", fixed, brains: size, connectome: h.connectome } : { type: "load", fixed, connectome: h.connectome });
    });
  }

  private async submit(job: { job: string }, result: unknown): Promise<void> {
    const h = this.hooks;
    // one retry on a dropped connection, so a finished job isn't thrown away
    await api(h.server, "/api/submit", h.getToken(), { job: job.job, result }).catch((err) => {
      if (err instanceof ApiError) throw err;
      return sleep(2_000).then(() => api(h.server, "/api/submit", h.getToken(), { job: job.job, result }));
    });
  }

  private async loop(lane: Lane, gen: number): Promise<void> {
    const h = this.hooks;
    while (gen === this.generation) {
      try {
        const claim = await api(h.server, "/api/claim", h.getToken(), { count: lane.size, kinds: lane.kinds, open_max: lane.openMax });
        if (gen !== this.generation) return; // stopped while claiming; the jobs expire on the server
        if (!claim) {
          h.lane(lane.index, "no jobs right now");
          await sleep(30_000);
          continue;
        }
        const all: (Claimed | ProgramClaim | ProbeClaim)[] = claim.jobs;
        const jobs = all.filter((j): j is Claimed => j.kind === undefined || j.kind === "connectome");
        const programs = all.filter((j): j is ProgramClaim => j.kind === "wasm" || j.kind === "wgsl" || j.kind === "world");
        const probes = all.filter((j): j is ProbeClaim => j.kind === "probe");
        h.job(all.length === 1 ? describeClaim(all[0]) : `${all.length} jobs at once, e.g. ${describeClaim(all[0])}`);
        if (jobs.length) {
          const results = await lane.run(jobs);
          if (gen !== this.generation) return;
          for (let k = 0; k < jobs.length; k++) {
            await this.submit(jobs[k], results[k]);
            this.session.jobs++;
            this.session.units += jobs[k].units ?? jobs[k].params.steps / 100;
          }
        }
        for (const job of probes) {
          if (!lane.probe) continue; // (only CPU lanes ask for probes)
          h.lane(lane.index, `running ${describeClaim(job)}`);
          const answer = await lane.probe(job.params);
          if (gen !== this.generation) return;
          await this.submit(job, answer);
          this.session.jobs++;
          this.session.units += job.units ?? 0;
        }
        for (const job of programs) {
          h.lane(lane.index, `running ${describeClaim(job)}`);
          const answer = await runProgram(h.server, job);
          if (gen !== this.generation) return;
          if (!answer) continue;
          await this.submit(job, answer);
          this.session.jobs++;
          this.session.units += job.units ?? 0;
        }
        const minutes = (performance.now() - this.session.since) / 60_000;
        h.session({ jobs: this.session.jobs, units: this.session.units, perMinute: this.session.jobs / Math.max(minutes, 1e-9) });
        h.lane(lane.index, "", 0);
      } catch (err) {
        if (gen !== this.generation) return;
        if (err instanceof ApiError && err.status === 401) {
          h.setToken(null);
          await this.ensureMiner().catch(() => {});
          continue;
        }
        h.lane(lane.index, err instanceof Error ? err.message : String(err));
        await sleep(err instanceof ApiError && err.status === 429 ? 15_000 : 10_000);
      }
    }
  }
}
