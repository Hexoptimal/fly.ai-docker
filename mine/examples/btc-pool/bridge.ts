/**
 * Mine Bitcoin (or any SHA-256d coin) at a pool with fly.ai compute miners.
 *
 * The bridge holds the pool connection; miners only ever see block headers. For each pool job it builds headers
 * (a fresh extranonce2 each time the 4 billion nonces run out), cuts the nonces into ranges, and adds one fly.ai job
 * per range to a keep-open order running ../hash-search/hash_search.wasm. Settled results come back with every
 * nonce that met the share target; the bridge re-hashes each one and submits it to the pool as a share. The pool pays
 * its account (your --user) as usual. Miners can't redirect that: the header commits to the pool's coinbase, so a
 * nonce found for it only counts there.
 *
 *   node examples/btc-pool/bridge.ts --pool stratum+tcp://HOST:PORT --user ACCOUNT[.WORKER] [--pass x]
 *        --order ORDER_ID --key ORDER_KEY [--server https://flyai-mine.fly.dev]
 *        [--per-job 1000000000] [--ahead 8] [--extranonce2-bytes N]
 *
 *   node examples/btc-pool/bridge.ts --pool ... --user ... --local [--per-job 20000000]
 *     no order: runs the jobs on this machine the way miners do, to check the pool setup before paying for anything
 *
 * Creating the order (keep-open, redundancy 1: a lying miner can't fake a share, since every hit is re-hashed here,
 * but it can hide one; redundancy 2 stops that at twice the price):
 *   node examples/hash-search/make-inputs.ts --out first/     # one small demo job to open the order with
 *   node examples/order.ts create --wallet 0x... --program examples/hash-search/hash_search.wasm --inputs first/ \
 *        --keep-open --redundancy 1 --timeout 120 --bid 40 --budget 20000
 *   node examples/order.ts pay --order ID --tx 0x...
 *
 * Sizing: a browser does very roughly 2-3 million hashes a second per thread, so --per-job 200000000 is about a
 * minute and a half. Keep --ahead small: jobs already queued when the pool moves to a new block are wasted.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runWasm } from "../../web/openjob.ts";
import {
  blockTarget, extranonce2Bytes, headerHash, headerPrefix, meets, shareTarget, StratumClient, type PoolJob,
} from "./stratum.ts";

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
const ORDER = flag("order");
const KEY = flag("key");
const PER_JOB = Number(flag("per-job") ?? (LOCAL ? 20_000_000 : 1_000_000_000));
const AHEAD = Number(flag("ahead") ?? 8);
const STOP_AFTER = flag("shares") ? Number(flag("shares")) : Infinity; // for tests: exit after this many accepted shares
if (!POOL || !USER || (!LOCAL && (!ORDER || !KEY))) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  process.exit(1);
}

const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);
const PROGRAM = readFileSync(new URL("../hash-search/hash_search.wasm", import.meta.url));

// ---- the pool --------------------------------------------------------------------------------------------------
const pool = new StratumClient(POOL, USER, flag("pass") ?? "x");
let job: PoolJob | null = null;
let en2Bytes = flag("extranonce2-bytes") ? Number(flag("extranonce2-bytes")) : 0;
let en2 = 0; // extranonce2 counter: a new header each time the nonce space of the last one is used up
let nonceAt = 0;
const stats = { jobs: 0, nonces: 0, accepted: 0, rejected: 0, stale: 0, started: Date.now() };

pool.on("job", (j: PoolJob) => {
  if (job && job.prevhash !== j.prevhash) log(`new block on the network: jobs already queued for the last one are stale`);
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
const works = new Map<string, Work>();

/** The next nonce range as a hash_search input (116 bytes). */
function nextInput(): { bytes: Buffer; work: Work } {
  const j = job!;
  // expected hits per job = nonces / (difficulty * 2^32); keep it well under the program's 64
  const perJob = Math.max(1, Math.min(PER_JOB, Math.floor(16 * pool.difficulty * 2 ** 32), 2 ** 32));
  if (nonceAt >= 2 ** 32) {
    en2++;
    nonceAt = 0;
  }
  const en2Hex = en2.toString(16).padStart(en2Bytes * 2, "0").slice(-en2Bytes * 2);
  const prefix = headerPrefix(j, pool.extranonce1, en2Hex);
  const count = Math.min(perJob, 2 ** 32 - nonceAt);
  const bytes = Buffer.alloc(116);
  prefix.copy(bytes, 0);
  bytes.writeUInt32LE(nonceAt >>> 0, 76);
  bytes.writeUInt32LE(count >>> 0, 80);
  shareTarget(pool.difficulty).copy(bytes, 84);
  nonceAt += count;
  return { bytes, work: { poolJob: j, en2: en2Hex, prefix } };
}

/** One job's output: re-hash every hit, and send the good ones to the pool. */
async function handleOutput(work: Work, output: Uint8Array, nonces: number): Promise<void> {
  stats.jobs++;
  stats.nonces += nonces;
  const view = Buffer.from(output);
  const hits = view.readUInt32LE(0);
  for (let i = 0; i < hits; i++) {
    const nonce = view.readUInt32LE(4 + i * 36);
    const claimed = view.subarray(8 + i * 36, 40 + i * 36);
    const hash = headerHash(work.prefix, nonce);
    if (!hash.equals(claimed) || !meets(hash, shareTarget(pool.difficulty))) {
      log(`ignored a hit that doesn't check out (nonce ${nonce}); a miner returned something false`);
      continue;
    }
    if (job && work.poolJob.prevhash !== job.prevhash) {
      stats.stale++;
      continue;
    }
    if (meets(hash, blockTarget(work.poolJob.nbits))) log(`this share is a whole block: ${hash.toString("hex")}`);
    const verdict = await pool.submit(work.poolJob.id, work.en2, work.poolJob.ntime, nonce);
    if (verdict.result === true) stats.accepted++;
    else stats.rejected++;
    log(`share ${hash.toString("hex").slice(0, 20)}… ${verdict.result === true ? "accepted" : `rejected: ${JSON.stringify(verdict.error)}`}`);
    if (stats.accepted >= STOP_AFTER) {
      report();
      pool.close();
      process.exit(0);
    }
  }
}

function report(): void {
  const s = (Date.now() - stats.started) / 1000;
  log(`${stats.jobs} jobs · ${(stats.nonces / 1e9).toFixed(2)} G hashes · ${(stats.nonces / s / 1e6).toFixed(2)} MH/s · shares ${stats.accepted} accepted, ${stats.rejected} rejected, ${stats.stale} stale`);
}

// ---- local: this machine plays the miners ------------------------------------------------------------------------
async function runLocal(): Promise<never> {
  for (;;) {
    const { bytes, work } = nextInput();
    const { output } = await runWasm(PROGRAM, bytes, new Uint8Array(32), 1 << 16);
    await handleOutput(work, output, bytes.readUInt32LE(80));
  }
}

// ---- fly.ai compute: jobs out, results back ----------------------------------------------------------------------
async function call(path: string, body?: unknown, key?: string): Promise<any> {
  const res = await fetch(SERVER + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${json.error ?? `HTTP ${res.status}`}`);
  return json;
}

async function runOrder(): Promise<never> {
  const nonces = new Map<string, number>();
  let after = 0;
  // results from before this run belong to headers this bridge no longer knows: start from the end
  for (let page = await call(`/api/orders/${ORDER}/results?after=0&limit=5000`); ; page = await call(`/api/orders/${ORDER}/results?after=${after}&limit=5000`)) {
    after = page.next;
    if (!page.more) break;
  }
  for (;;) {
    const o = await call(`/api/orders/${ORDER}`);
    if (o.status !== "live") throw new Error(`the order is ${o.status}${o.end_reason ? ` (${o.end_reason})` : ""}; top it up or make a new one`);
    const waiting = o.jobs - o.settled;
    if (waiting < AHEAD) {
      const inputs: string[] = [];
      for (let i = waiting; i < AHEAD; i++) {
        const { bytes, work } = nextInput();
        const hash = createHash("sha256").update(bytes).digest("hex");
        const res = await fetch(`${SERVER}/api/blobs`, { method: "POST", body: bytes as BodyInit });
        if (!res.ok) throw new Error(`upload: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
        works.set(hash, work);
        nonces.set(hash, bytes.readUInt32LE(80));
        inputs.push(hash);
      }
      await call(`/api/orders/${ORDER}/jobs`, { inputs }, KEY);
    }
    const page = await call(`/api/orders/${ORDER}/results?after=${after}&limit=1000`);
    for (const row of page.rows) {
      const work = row.input ? works.get(row.input) : undefined;
      if (!work) continue; // not ours (the opening demo job, or an earlier run)
      works.delete(row.input);
      if (row.output) {
        const bytes = new Uint8Array(await (await fetch(SERVER + row.output.url)).arrayBuffer());
        await handleOutput(work, bytes, nonces.get(row.input) ?? 0);
      } else {
        log(`a job came back with no output (${row.error ?? row.checked_by}); its nonces are skipped`);
      }
      nonces.delete(row.input);
    }
    after = page.next;
    if (!page.more) await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---- start ---------------------------------------------------------------------------------------------------------
await pool.start();
log(`connected to ${POOL} as ${USER}; waiting for work`);
for (let i = 0; !job; i++) {
  if (i > 300) throw new Error("the pool sent no job in 30 s");
  await new Promise((r) => setTimeout(r, 100));
}
log(`first job: extranonce2 is ${en2Bytes} bytes, share difficulty ${pool.difficulty}`);
setInterval(report, 30_000).unref();
await (LOCAL ? runLocal() : runOrder());
