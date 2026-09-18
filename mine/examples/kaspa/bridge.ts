/**
 * Mine Kaspa at a pool with fly.ai compute miners' GPUs, for the project itself.
 *
 * The bridge holds the pool connection. For each pool job it builds the job's 64x64 matrix (whose rank check needs
 * 64-bit floats, which WGSL hasn't got), cuts the nonce space into ranges, and adds one job per range to a
 * keep-open house order running khh.wgsl. Settled results come back with the nonces that met the share target; the
 * bridge re-hashes each one here and submits the good ones. The pool pays the address in --user.
 *
 *   node examples/kaspa/bridge.ts --pool stratum+tcp://HOST:PORT --user kaspa:ADDRESS[.WORKER]
 *        [--server https://flyai-mine.fly.dev] [--admin TOKEN] [--groups 1024] [--per-thread 64] [--ahead 8]
 *
 *   node examples/kaspa/bridge.ts --pool ... --user ... --local
 *     no order: searches on this machine's CPU with khh.ts (slow, for checking a pool before pointing the fleet at it)
 *
 * Be clear-eyed about what this earns. Measured on an RTX 4060, the shader does 11 MH/s, about 2% of what the same
 * card does natively, and Kaspa's network is ASIC-dominated: a browser is worth a small fraction of a cent a year.
 * It exists because it is the one GPU proof-of-work with a published specification and test vectors, so it proves
 * the whole path - pool, jobs, miners, shares - with a shader that can be swapped for a better-paid one later.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildInput, INPUT_BYTES, OUTPUT_BYTES, readHits } from "./job.ts";
import { generateMatrix, kHeavyHash, meetsTarget, targetFromDifficulty } from "./khh.ts";
import { KaspaStratum, withExtranonce, type KaspaJob } from "./stratum.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const POOL = flag("pool");
const USER = flag("user");
const LOCAL = has("local");
const SERVER = flag("server") ?? process.env.FLYAI_SERVER ?? "https://flyai-mine.fly.dev";
const ADMIN = flag("admin") ?? process.env.ADMIN_TOKEN ?? "";
const LABEL = flag("label") ?? "mining/kaspa";
const GROUPS = Number(flag("groups") ?? 1024);
const PER_THREAD = Number(flag("per-thread") ?? (LOCAL ? 1 : 64));
const AHEAD = Number(flag("ahead") ?? 8);
const UNITS = Number(flag("units") ?? 3);
const TIMEOUT = Number(flag("timeout") ?? 120);
const LOCAL_NONCES = Number(flag("local-nonces") ?? 20_000);
const STOP_AFTER = flag("shares") ? Number(flag("shares")) : Infinity; // for tests
if (!POOL || !USER || (!LOCAL && !ADMIN)) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  process.exit(1);
}
const NONCES_PER_JOB = GROUPS * 64 * PER_THREAD;
const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);
const SHADER = readFileSync(new URL("./khh.wgsl", import.meta.url));

// ---- the pool --------------------------------------------------------------------------------------------------
const pool = new KaspaStratum(POOL, USER, flag("pass") ?? "x");
let job: KaspaJob | null = null;
let matrix: Uint8Array | null = null;
let counter = 0n;
const stats = { jobs: 0, nonces: 0, accepted: 0, rejected: 0, stale: 0, bad: 0, started: Date.now() };

// Kaspa runs at ten blocks a second, so the pool pushes jobs constantly. The matrix is built only when work is
// actually cut from a job (see matrixFor), not for every job that flies past.
pool.on("job", (j: KaspaJob) => {
  job = j;
  counter = 0n;
});

let matrixFor = "";
function currentMatrix(j: KaspaJob): Uint8Array {
  if (matrixFor !== j.id || !matrix) {
    matrix = generateMatrix(j.prePowHash);
    matrixFor = j.id;
  }
  return matrix;
}
pool.on("difficulty", (d: number) => log(`pool share difficulty ${d}`));
pool.on("extranonce", (e: string) => log(`extranonce prefix ${e || "(none)"}`));
pool.on("close", () => { log("pool connection closed"); process.exit(2); });
pool.on("error", (err: Error) => { log(`pool error: ${err.message}`); process.exit(2); });

/** What a job's hits belong to: the pool job and matrix they were found under. */
interface Work { poolJob: KaspaJob; matrix: Uint8Array; target: Uint8Array; first: bigint; count: number }

function nextWork(count: number): { bytes: Uint8Array; work: Work } {
  const j = job!;
  const target = targetFromDifficulty(pool.difficulty);
  const first = withExtranonce(pool.extranonce, counter);
  counter += BigInt(count);
  const m = currentMatrix(j);
  const bytes = buildInput({ prePowHash: j.prePowHash, timestamp: j.timestamp, firstNonce: first, perThread: PER_THREAD, target, matrix: m });
  return { bytes, work: { poolJob: j, matrix: m, target, first, count } };
}

/** Re-hash every hit here, then send the good ones to the pool. */
async function handleOutput(work: Work, output: Uint8Array): Promise<void> {
  stats.jobs++;
  stats.nonces += work.count;
  for (const hit of readHits(output)) {
    const hash = kHeavyHash(work.matrix, work.poolJob.prePowHash, work.poolJob.timestamp, hit.nonce);
    if (Buffer.compare(Buffer.from(hash), Buffer.from(hit.hash)) !== 0 || !meetsTarget(hash, work.target)) {
      stats.bad++;
      log(`ignored a hit that doesn't check out (nonce ${hit.nonce}); a miner returned something false`);
      continue;
    }
    if (job && job.id !== work.poolJob.id) {
      stats.stale++;
      continue;
    }
    const verdict = await pool.submit(work.poolJob.id, hit.nonce);
    if (verdict.result === true) stats.accepted++;
    else stats.rejected++;
    log(`share nonce ${hit.nonce} ${verdict.result === true ? "accepted" : `rejected: ${JSON.stringify(verdict.error)}`}`);
    if (stats.accepted >= STOP_AFTER) {
      report();
      pool.close();
      process.exit(0);
    }
  }
}

function report(): void {
  const s = (Date.now() - stats.started) / 1000;
  log(`${stats.jobs} jobs · ${(stats.nonces / 1e6).toFixed(2)} M hashes · ${(stats.nonces / s / 1e6).toFixed(2)} MH/s · shares ${stats.accepted} accepted, ${stats.rejected} rejected, ${stats.stale} stale, ${stats.bad} bad`);
}

// ---- local: this machine searches on its CPU ---------------------------------------------------------------------
async function runLocal(): Promise<never> {
  for (;;) {
    const { work } = nextWork(LOCAL_NONCES);
    const found: { nonce: bigint; hash: Uint8Array }[] = [];
    for (let i = 0; i < LOCAL_NONCES; i++) {
      const nonce = BigInt.asUintN(64, work.first + BigInt(i));
      const hash = kHeavyHash(work.matrix, work.poolJob.prePowHash, work.poolJob.timestamp, nonce);
      if (meetsTarget(hash, work.target)) found.push({ nonce, hash });
      if (found.length === 16) break;
    }
    // shaped like the shader's output, so both paths go through the same checks
    const out = new Uint8Array(OUTPUT_BYTES);
    const view = new DataView(out.buffer);
    view.setUint32(0, found.length, true);
    found.forEach((h, i) => {
      view.setBigUint64(4 + i * 40, h.nonce, true);
      out.set(h.hash, 12 + i * 40);
    });
    await handleOutput(work, out);
  }
}

// ---- fly.ai compute: jobs out, results back ----------------------------------------------------------------------
async function call(path: string, body?: unknown, admin = false): Promise<any> {
  const res = await fetch(SERVER + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${json.error ?? `HTTP ${res.status}`}`);
  return json;
}

/** Uploads as admin (no per-IP cap). A busy or restarting server is waited out, not fatal. */
async function upload(bytes: Uint8Array): Promise<string> {
  for (let wait = 5; ; wait = Math.min(wait * 2, 120)) {
    const res = await fetch(`${SERVER}/api/blobs`, {
      method: "POST", body: bytes as BodyInit, headers: ADMIN ? { authorization: `Bearer ${ADMIN}` } : {},
    }).catch(() => null);
    if (res?.ok) return (await res.json()).hash as string;
    const why = res ? (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}` : "server unreachable";
    if (res && res.status !== 429 && res.status < 500) throw new Error(`upload: ${why}`);
    log(`upload: ${why}; retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

async function openOrder(): Promise<string> {
  const mine = ((await call("/api/house")).orders as { id: string; label: string; status: string }[])
    .find((o) => o.label === LABEL && o.status === "live");
  if (mine) {
    log(`carrying on with house order ${mine.id.slice(0, 8)} (${LABEL})`);
    return mine.id;
  }
  const program = await upload(new Uint8Array(SHADER));
  const { bytes } = nextWork(NONCES_PER_JOB);
  const first = await upload(bytes);
  const made = await call("/api/admin/house", {
    label: LABEL,
    units: UNITS,
    spec: {
      kind: "wgsl", program, inputs: [first], timeout_s: TIMEOUT, redundancy: 1, keep_open: true,
      dispatch: [GROUPS, 1, 1], output_bytes: OUTPUT_BYTES,
    },
  }, true);
  log(`house order ${String(made.id).slice(0, 8)} started (${LABEL}), ${NONCES_PER_JOB.toLocaleString("en-US")} nonces a job`);
  return made.id;
}

async function runOrder(): Promise<never> {
  const order = await openOrder();
  const works = new Map<string, Work>();
  let after = 0;
  for (let page = await call(`/api/orders/${order}/results?after=0&limit=5000`); ; page = await call(`/api/orders/${order}/results?after=${after}&limit=5000`)) {
    after = page.next;
    if (!page.more) break;
  }
  for (;;) {
    const o = await call(`/api/orders/${order}`);
    if (o.status !== "live") throw new Error(`the order is ${o.status}${o.end_reason ? ` (${o.end_reason})` : ""}; start another`);
    const waiting = o.jobs - o.settled;
    if (waiting < AHEAD) {
      const inputs: string[] = [];
      for (let i = waiting; i < AHEAD; i++) {
        const { bytes, work } = nextWork(NONCES_PER_JOB);
        if (bytes.length !== INPUT_BYTES) throw new Error("the job input is the wrong size");
        works.set(createHash("sha256").update(bytes).digest("hex"), work);
        await upload(bytes);
        inputs.push(createHash("sha256").update(bytes).digest("hex"));
      }
      await call(`/api/admin/house/${order}/jobs`, { inputs }, true);
    }
    const page = await call(`/api/orders/${order}/results?after=${after}&limit=1000`);
    for (const row of page.rows) {
      const work = row.input ? works.get(row.input) : undefined;
      if (!work) continue;
      works.delete(row.input);
      if (row.output) {
        await handleOutput(work, new Uint8Array(await (await fetch(SERVER + row.output.url)).arrayBuffer()));
      } else {
        log(`a job came back with no output (${row.error ?? row.checked_by}); its nonces are skipped`);
      }
    }
    after = page.next;
    if (!page.more) await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---- start ---------------------------------------------------------------------------------------------------------
await pool.start();
log(`connected to ${POOL} as ${USER}`);
for (let i = 0; !job; i++) {
  if (i > 300) throw new Error("the pool sent no job in 30 s");
  await new Promise((r) => setTimeout(r, 100));
}
log(`first job: share difficulty ${pool.difficulty}`);
setInterval(report, 30_000).unref();
await (LOCAL ? runLocal() : runOrder());
