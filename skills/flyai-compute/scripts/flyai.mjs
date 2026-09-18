#!/usr/bin/env node
/**
 * fly.ai compute from the command line: price a job, order it, hand over a pay link, then collect the results.
 * Plain Node 18+ (built-in fetch), no dependencies. Every command prints JSON on the last line for scripts.
 *
 *   node flyai.mjs config                                          prices, limits, token, pay_to
 *   node flyai.mjs quote  (--spec spec.json | --program f.wasm|f.wgsl [program options]) [--bid N]
 *   node flyai.mjs create --wallet 0x... (--spec spec.json | --program ...) [--bid N] [--budget N] [--hours H] [--webhook URL]
 *       creates the order (unpaid), saves its key to order-<id8>.json and prints the pay link
 *   node flyai.mjs pay    --order ID --tx 0x... [--chain base]    only if the buyer paid by a transfer themselves
 *   node flyai.mjs status --order ID
 *   node flyai.mjs watch  --order ID [--out dir] [--once]          downloads every settled output as it arrives
 *   node flyai.mjs add    --order ID (--count N | --inputs dir)    more jobs for a keep-open order (key from order-*.json)
 *   node flyai.mjs stop   --order ID                               what isn't spent goes back to the wallet's balance
 *
 * Program options: --count N (job i gets i as a u32) or --inputs dir (one job per file), --timeout S (60),
 *   --redundancy R (2), --keep-open; WGSL also --dispatch x,y,z --output-bytes N [--tolerance 0.0001].
 * FLYAI_SERVER overrides the API (default https://flyai-mine.fly.dev).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, ...rest] = process.argv.slice(2);
// a failed call is a message for the person, not a stack trace
process.on("uncaughtException", (err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name) => rest.includes(`--${name}`);
const SERVER = flag("server") ?? process.env.FLYAI_SERVER ?? "https://flyai-mine.fly.dev";
const SITE = "https://www.flyaiworld.com";
const say = (text) => console.error(text); // human notes on stderr, JSON on stdout
const out = (json) => console.log(JSON.stringify(json));

async function call(path, body, key) {
  const res = await fetch(SERVER + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${json.error ?? `HTTP ${res.status}`}`);
  return json;
}

async function upload(bytes) {
  const res = await fetch(`${SERVER}/api/blobs`, { method: "POST", body: bytes });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload: ${json.error ?? `HTTP ${res.status}`}`);
  return json.hash;
}

async function inputsFrom(dir) {
  const files = readdirSync(dir).filter((f) => !f.startsWith(".")).sort();
  const hashes = [];
  for (const [i, f] of files.entries()) {
    process.stderr.write(`\ruploading inputs ${i + 1}/${files.length}`);
    hashes.push(await upload(readFileSync(join(dir, f))));
  }
  process.stderr.write("\n");
  return hashes;
}

/** The order's spec: a JSON file (any kind, e.g. connectome-sweep), or a program uploaded here. */
async function specFromFlags() {
  if (flag("spec")) return JSON.parse(readFileSync(flag("spec"), "utf8"));
  const path = flag("program");
  if (!path) throw new Error("give --spec spec.json or --program file.wasm|file.wgsl");
  const kind = path.endsWith(".wgsl") ? "wgsl" : "wasm";
  const program = await upload(readFileSync(path));
  const jobs = flag("inputs") ? { inputs: await inputsFrom(flag("inputs")) } : { count: Number(flag("count") ?? 1) };
  const spec = {
    kind, program, ...jobs, timeout_s: Number(flag("timeout") ?? 60), redundancy: Number(flag("redundancy") ?? 2), keep_open: has("keep-open"),
  };
  if (kind === "wgsl") {
    if (!flag("output-bytes")) throw new Error("a WGSL job needs --output-bytes (and usually --dispatch x,y,z)");
    spec.dispatch = (flag("dispatch") ?? "1,1,1").split(",").map(Number);
    spec.output_bytes = Number(flag("output-bytes"));
    if (flag("tolerance")) spec.compare = { f32_tolerance: Number(flag("tolerance")) };
  }
  return spec;
}

const keyFile = (id) => `order-${id.slice(0, 8)}.json`;
function orderKey(id) {
  if (flag("key")) return flag("key");
  const file = keyFile(id);
  if (!existsSync(file)) throw new Error(`no --key and no ${file} here: the order key was saved there when the order was made`);
  return JSON.parse(readFileSync(file, "utf8")).order_key;
}

if (command === "config") {
  out(await call("/api/orders/config"));
} else if (command === "quote") {
  const spec = await specFromFlags();
  const quote = await call("/api/orders/quote", { spec, bid: flag("bid") });
  say(`${quote.jobs} jobs (${quote.cached} already done, cheaper) at ${quote.bid} $FLYAI each: the whole order costs at most ${quote.full_cost} $FLYAI`);
  out({ ...quote, spec });
} else if (command === "create") {
  const wallet = flag("wallet");
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet ?? "")) throw new Error("--wallet 0x... is required: the wallet that pays and owns the order");
  const spec = await specFromFlags();
  const quote = await call("/api/orders/quote", { spec, bid: flag("bid") });
  const order = await call("/api/orders", {
    wallet, spec, bid: flag("bid") ?? quote.bid, budget: flag("budget") ?? quote.full_cost,
    hours: flag("hours") ? Number(flag("hours")) : undefined, webhook: flag("webhook"),
  });
  writeFileSync(keyFile(order.id), JSON.stringify({ id: order.id, order_key: order.order_key, webhook_secret: order.webhook_secret, server: SERVER }, null, 2));
  const payLink = `${SITE}/compute/jobs?pay=${order.id}`;
  say(`order ${order.id} created, unpaid (its key is in ${keyFile(order.id)}; it isn't shown again)`);
  say(`pay ${order.budget} $FLYAI from ${order.wallet}: ${payLink}`);
  out({ id: order.id, status: order.status, budget: order.budget, budget_wei: order.budget_wei, wallet: order.wallet, pay_to: order.pay_to, token: order.token, pay_link: payLink, key_file: keyFile(order.id) });
} else if (command === "pay") {
  // for a buyer who sent the transfer themselves: tell the server which transaction it was
  for (let i = 0; ; i++) {
    try {
      const o = await call(`/api/orders/${flag("order")}/pay`, { tx: flag("tx"), chain: flag("chain") });
      say(`order ${o.id}: ${o.status}, ${o.out} jobs out to miners`);
      out(o);
      break;
    } catch (err) {
      if (!/isn't mined yet|couldn't read the chain/.test(String(err)) || i > 40) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
} else if (command === "status") {
  const o = await call(`/api/orders/${flag("order")}`);
  say(`order ${o.id}: ${o.status}${o.end_reason ? ` (${o.end_reason})` : ""} · ${o.settled}/${o.jobs} settled · spent ${o.spent ?? "0"} of ${o.budget} $FLYAI`);
  out(o);
} else if (command === "watch") {
  const id = flag("order");
  const dir = flag("out") ?? `results-${id.slice(0, 8)}`;
  mkdirSync(dir, { recursive: true });
  const cursorFile = join(dir, "cursor.json");
  let after = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")).next : 0;
  let page;
  for (;;) {
    page = await call(`/api/orders/${id}/results?after=${after}&limit=1000`);
    for (const row of page.rows) {
      const name = String(row.index ?? row.seq).padStart(6, "0"); // program jobs have an index, sweep rows a seq
      if (row.output?.url) writeFileSync(join(dir, `${name}.out`), Buffer.from(await (await fetch(SERVER + row.output.url)).arrayBuffer()));
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(row));
    }
    after = page.next;
    writeFileSync(cursorFile, JSON.stringify({ next: after }));
    process.stderr.write(`\r${page.status}: ${page.settled}/${page.jobs} settled`);
    const finished = (page.status === "done" || page.status === "ended") && !page.more;
    if (finished || (has("once") && !page.more)) break;
    if (!page.more) await new Promise((r) => setTimeout(r, 10_000));
  }
  say(`\noutputs in ${dir}/ (N.out = the output, N.json = the row: checked_by, error, disputed answers)`);
  out({ id, status: page.status, jobs: page.jobs, settled: page.settled, dir });
} else if (command === "add") {
  const id = flag("order");
  const jobs = flag("inputs") ? { inputs: await inputsFrom(flag("inputs")) } : { count: Number(flag("count")) };
  const o = await call(`/api/orders/${id}/jobs`, jobs, orderKey(id));
  say(`order ${o.id}: now ${o.jobs} jobs`);
  out(o);
} else if (command === "stop") {
  const id = flag("order");
  const o = await call(`/api/orders/${id}/stop`, {}, orderKey(id));
  say(`order ${o.id}: ${o.status}; ${o.returned} $FLYAI back to the wallet's balance`);
  out(o);
} else {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*\n/, ""));
}
