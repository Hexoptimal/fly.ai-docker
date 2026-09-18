/**
 * Mine a yespower coin at a pool with fly.ai compute miners, for the project itself.
 *
 * The bridge holds the pool connection; miners only ever see block headers. For each pool job it builds headers
 * (a fresh extranonce2 when the nonce space runs out), cuts the nonces into ranges, and adds one job per range to a
 * keep-open house order running ../yespower/yespower_search.wasm. Settled results come back with every nonce that
 * met the share target; the bridge re-hashes each one here and submits the good ones to the pool. The pool pays the
 * address in --user. Miners can't redirect that: the header commits to the pool's coinbase.
 *
 * Unlike ../btc-pool (which spends a buyer's order), this runs as a HOUSE order: our own work, no payment, and the
 * miners earn their usual points for it.
 *
 *   node examples/yespower-pool/bridge.ts --pool stratum+tcp://HOST:PORT --user ADDRESS[.WORKER] [--pass x]
 *        [--coin yescrypt] [--server https://flyai-mine.fly.dev] [--admin TOKEN] [--label mining/yescrypt]
 *        [--per-job 1000] [--ahead 16] [--lead 8] [--units 2]
 *
 *   node examples/yespower-pool/bridge.ts --pool ... --user ... --local
 *     no order: runs the jobs here the way miners do, to check a pool before pointing the fleet at it
 *
 * Timing is everything. A pool job lives only until the pool sends a "clean" one (zpool: every 20-60 s, even on the
 * same block), and a share for a retired job is refused ("Invalid job id"). So jobs are short (--per-job 1000 is about
 * 4 s of a browser thread at ~250 hashes a second), only about --lead seconds of work waits in the queue at the
 * fleet's current pace (at most --ahead jobs), results are polled every second, and a share is sent only while its
 * pool job is still alive. Work still queued when a job retires is wasted, which the short queue keeps small.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runWasm } from "../../web/openjob.ts";
import { extranonce2Bytes, headerPrefix, meets, shareTarget, StratumClient, type PoolJob } from "../btc-pool/stratum.ts";
import { COINS, display, hits, input, PROGRAM, yespowerHash, type Params } from "./hash.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const POOL = flag("pool");
const USER = flag("user");
const LOCAL = has("local");
const COIN = flag("coin") ?? "yescrypt";
const SERVER = flag("server") ?? process.env.FLYAI_SERVER ?? "https://flyai-mine.fly.dev";
const ADMIN = flag("admin") ?? process.env.ADMIN_TOKEN ?? "";
const LABEL = flag("label") ?? `mining/${COIN}`;
const PER_JOB = Number(flag("per-job") ?? 1_000);
const AHEAD = Number(flag("ahead") ?? 16);
/** jobs always waiting: miners run them side by side, so too few starves the fleet (a queue of 2 let only two
 *  miners mine at once, which kept the measured pace, and so the queue, low) */
const MIN_AHEAD = Number(flag("min-ahead") ?? 6);
/** seconds of work to keep waiting at the fleet's current pace */
const LEAD_S = Number(flag("lead") ?? 8);
const UNITS = Number(flag("units") ?? 2);
const TIMEOUT = Number(flag("timeout") ?? 60);
const STOP_AFTER = flag("shares") ? Number(flag("shares")) : Infinity; // for tests: exit after this many accepted shares
// The yescrypt/yespower family states difficulty 65536x smaller than Bitcoin does (cpuminer's
// work_set_target(work, diff / 65536) for these algorithms). Pools that don't, take --diff-divisor 1.
const DIFF_DIVISOR = Number(flag("diff-divisor") ?? 65536);
const params: Params | undefined = COINS[COIN];
if (!POOL || !USER || !params || (!LOCAL && !ADMIN)) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  if (POOL && USER && !params) console.log(`unknown coin ${COIN}; known: ${Object.keys(COINS).join(", ")}`);
  if (POOL && USER && params && !LOCAL && !ADMIN) console.log("--admin (or ADMIN_TOKEN) is needed to start our own house order");
  process.exit(1);
}

const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);

// ---- the pool --------------------------------------------------------------------------------------------------
const pool = new StratumClient(POOL, USER, flag("pass") ?? "x");
let job: PoolJob | null = null;
let en2Bytes = flag("extranonce2-bytes") ? Number(flag("extranonce2-bytes")) : 0;
let en2 = 0;
let nonceAt = 0;
const stats = { jobs: 0, nonces: 0, accepted: 0, rejected: 0, stale: 0, bad: 0, started: Date.now() };

/** Pool jobs a share can still be sent for: a clean job retires every earlier one. */
const alive = new Set<string>();
pool.on("job", (j: PoolJob, clean: boolean) => {
  if (clean) alive.clear();
  alive.add(j.id);
  job = j;
  if (!en2Bytes) en2Bytes = extranonce2Bytes(j, pool.extranonce1);
  en2 = 0;
  nonceAt = 0;
});
pool.on("difficulty", (d: number) => log(`pool share difficulty ${d}`));
pool.on("message", (m: string) => log(`pool: ${m}`));
pool.on("close", () => { log("pool connection closed"); process.exit(2); });
pool.on("error", (err: Error) => { log(`pool error: ${err.message}`); process.exit(2); });

/** Where a job's hits go: which pool job and extranonce2 its header was built from. */
interface Work { poolJob: PoolJob; en2: string; prefix: Buffer }

/** The next nonce range as a job input. */
function nextInput(): { bytes: Buffer; work: Work } {
  const j = job!;
  if (nonceAt >= 2 ** 32) {
    en2++;
    nonceAt = 0;
  }
  const en2Hex = en2.toString(16).padStart(en2Bytes * 2, "0").slice(-en2Bytes * 2);
  const prefix = headerPrefix(j, pool.extranonce1, en2Hex);
  const count = Math.min(PER_JOB, 2 ** 32 - nonceAt);
  const target = shareTarget(pool.difficulty / DIFF_DIVISOR);
  const bytes = input(prefix, nonceAt, count, target, params!, prefix);
  nonceAt += count;
  return { bytes, work: { poolJob: j, en2: en2Hex, prefix } };
}

/** One job's output: re-hash every hit here, and send the good ones to the pool. */
async function handleOutput(work: Work, output: Uint8Array, nonces: number): Promise<void> {
  stats.jobs++;
  stats.nonces += nonces;
  for (const hit of hits(output)) {
    const header = Buffer.alloc(80);
    work.prefix.copy(header, 0, 0, 76);
    header.writeUInt32LE(hit.nonce >>> 0, 76);
    const hash = await yespowerHash(header, params!);
    if (!hash.equals(hit.hash) || !meets(display(hash), shareTarget(pool.difficulty / DIFF_DIVISOR))) {
      stats.bad++;
      log(`ignored a hit that doesn't check out (nonce ${hit.nonce}); a miner returned something false`);
      continue;
    }
    if (!alive.has(work.poolJob.id)) {
      stats.stale++; // the pool has retired this job: it would refuse the share
      continue;
    }
    const verdict = await pool.submit(work.poolJob.id, work.en2, work.poolJob.ntime, hit.nonce);
    if (verdict.result === true) stats.accepted++;
    else stats.rejected++;
    log(`share ${display(hash).toString("hex").slice(0, 20)}… ${verdict.result === true ? "accepted" : `rejected: ${JSON.stringify(verdict.error)}`}`);
    if (stats.accepted >= STOP_AFTER) {
      report();
      pool.close();
      process.exit(0);
    }
  }
}

function report(): void {
  const s = (Date.now() - stats.started) / 1000;
  log(`${stats.jobs} jobs · ${stats.nonces.toLocaleString("en-US")} hashes · ${(stats.nonces / s).toFixed(0)} H/s · shares ${stats.accepted} accepted, ${stats.rejected} rejected, ${stats.stale} stale, ${stats.bad} bad`);
}

// ---- local: this machine plays the miners ------------------------------------------------------------------------
async function runLocal(): Promise<never> {
  for (;;) {
    const { bytes, work } = nextInput();
    const { output } = await runWasm(new Uint8Array(PROGRAM), new Uint8Array(bytes), new Uint8Array(32), 1 << 16);
    await handleOutput(work, output, bytes.readUInt32LE(80));
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
async function upload(bytes: Buffer): Promise<string> {
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

/** Our mining order, made once and reused: a keep-open house order running the yespower program. */
async function openOrder(): Promise<string> {
  const mine = ((await call("/api/house")).orders as { id: string; label: string; status: string }[])
    .find((o) => o.label === LABEL && o.status === "live");
  if (mine) {
    log(`carrying on with house order ${mine.id.slice(0, 8)} (${LABEL})`);
    return mine.id;
  }
  const program = await upload(PROGRAM);
  const { bytes } = nextInput(); // one job to open with; its result is picked up like any other
  const first = await upload(bytes);
  const made = await call("/api/admin/house", {
    label: LABEL,
    units: UNITS,
    spec: { kind: "wasm", program, inputs: [first], timeout_s: TIMEOUT, redundancy: 1, keep_open: true },
  }, true);
  log(`house order ${String(made.id).slice(0, 8)} started (${LABEL})`);
  return made.id;
}

async function runOrder(): Promise<never> {
  const order = await openOrder();
  const works = new Map<string, Work>();
  const nonces = new Map<string, number>();
  let after = 0;
  // results from before this run belong to headers this bridge no longer knows: start from the end
  for (let page = await call(`/api/orders/${order}/results?after=0&limit=5000`); ; page = await call(`/api/orders/${order}/results?after=${after}&limit=5000`)) {
    after = page.next;
    if (!page.more) break;
  }
  const back: number[] = []; // when each of our jobs came back, over the last minute: the fleet's pace
  for (;;) {
    const o = await call(`/api/orders/${order}`);
    if (o.status !== "live") throw new Error(`the order is ${o.status}${o.end_reason ? ` (${o.end_reason})` : ""}; start another`);
    const waiting = o.jobs - o.settled;
    while (back.length && back[0] < Date.now() - 60_000) back.shift();
    const want = Math.min(AHEAD, Math.max(MIN_AHEAD, Math.ceil((back.length / 60) * LEAD_S)));
    if (waiting < want) {
      const inputs: string[] = [];
      for (let i = waiting; i < want; i++) {
        const { bytes, work } = nextInput();
        const hash = createHash("sha256").update(bytes).digest("hex");
        await upload(bytes);
        works.set(hash, work);
        nonces.set(hash, bytes.readUInt32LE(80));
        inputs.push(hash);
      }
      await call(`/api/admin/house/${order}/jobs`, { inputs }, true);
    }
    const page = await call(`/api/orders/${order}/results?after=${after}&limit=1000`);
    for (const row of page.rows) {
      const work = row.input ? works.get(row.input) : undefined;
      if (!work) continue; // not ours: an earlier run of the bridge
      works.delete(row.input);
      back.push(Date.now());
      if (row.output) {
        const bytes = new Uint8Array(await (await fetch(SERVER + row.output.url)).arrayBuffer());
        await handleOutput(work, bytes, nonces.get(row.input) ?? 0);
      } else {
        log(`a job came back with no output (${row.error ?? row.checked_by}); its nonces are skipped`);
      }
      nonces.delete(row.input);
    }
    after = page.next;
    if (!page.more) await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---- start ---------------------------------------------------------------------------------------------------------
await pool.start();
log(`connected to ${POOL} as ${USER}; mining ${COIN} (yespower ${params.version === 0 ? "0.5" : "1.0"}, N=${params.N}, r=${params.r})`);
for (let i = 0; !job; i++) {
  if (i > 300) throw new Error("the pool sent no job in 30 s");
  await new Promise((r) => setTimeout(r, 100));
}
log(`first job: extranonce2 is ${en2Bytes} bytes, share difficulty ${pool.difficulty}`);
setInterval(report, 30_000).unref();
await (LOCAL ? runLocal() : runOrder());
