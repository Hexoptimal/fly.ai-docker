/**
 * Order a program on fly.ai compute from the command line, pay for it, and collect the results.
 *
 *   node examples/order.ts create --wallet 0x... --program pi-rust/pi.wasm --count 1000 [--bid 20] [--budget 20000]
 *        [--timeout 60] [--redundancy 2] [--inputs dir] [--keep-open] [--webhook https://...] [--server URL]
 *     uploads the program (and every file in --inputs, one job each), prices it, creates the order and prints how to pay
 *
 *   node examples/order.ts pay --order ID --tx 0x...        after sending the exact budget_wei to pay_to
 *   node examples/order.ts watch --order ID --out results/   downloads every settled output as it arrives
 *   node examples/order.ts add --order ID --key ORDER_KEY (--count N | --inputs dir)   more jobs (keep-open orders)
 *   node examples/order.ts stop --order ID --key ORDER_KEY
 *
 * Paying: send one $FLYAI transfer of exactly budget_wei from --wallet to pay_to, from any wallet app, or with Foundry:
 *   cast send 0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C "transfer(address,uint256)" <pay_to> <budget_wei> \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $KEY
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(`--${name}`);
const SERVER = flag("server") ?? process.env.FLYAI_SERVER ?? "https://flyai-mine.fly.dev";

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

async function upload(bytes: Uint8Array): Promise<string> {
  const res = await fetch(`${SERVER}/api/blobs`, { method: "POST", body: bytes as BodyInit });
  const json = await res.json();
  if (!res.ok) throw new Error(`upload: ${json.error}`);
  return json.hash;
}

async function inputsFrom(dir: string): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => !f.startsWith(".")).sort();
  const hashes: string[] = [];
  for (const [i, f] of files.entries()) {
    process.stdout.write(`\ruploading inputs ${i + 1}/${files.length}`);
    hashes.push(await upload(readFileSync(join(dir, f))));
  }
  process.stdout.write("\n");
  return hashes;
}

if (command === "create") {
  const programPath = flag("program");
  const wallet = flag("wallet");
  if (!programPath || !wallet) throw new Error("--program and --wallet are required");
  const kind = programPath.endsWith(".wgsl") ? "wgsl" : "wasm";
  const program = await upload(readFileSync(programPath));
  const jobs = flag("inputs") ? { inputs: await inputsFrom(flag("inputs")!) } : { count: Number(flag("count") ?? 1) };
  const spec: Record<string, unknown> = {
    kind, program, ...jobs, timeout_s: Number(flag("timeout") ?? 60), redundancy: Number(flag("redundancy") ?? 2), keep_open: has("keep-open"),
  };
  if (kind === "wgsl") {
    spec.dispatch = (flag("dispatch") ?? "1,1,1").split(",").map(Number);
    spec.output_bytes = Number(flag("output-bytes"));
    if (flag("tolerance")) spec.compare = { f32_tolerance: Number(flag("tolerance")) };
  }
  const quote = await call("/api/orders/quote", { spec, bid: flag("bid") });
  console.log(`${quote.jobs} jobs at ${quote.bid} $FLYAI each (lowest ${quote.min_bid}); the whole order costs at most ${quote.full_cost} $FLYAI`);
  const order = await call("/api/orders", { wallet, spec, bid: flag("bid") ?? quote.min_bid, budget: flag("budget") ?? quote.full_cost, webhook: flag("webhook") });
  const saved = `order-${order.id.slice(0, 8)}.json`;
  writeFileSync(saved, JSON.stringify({ id: order.id, order_key: order.order_key, webhook_secret: order.webhook_secret, server: SERVER }, null, 2));
  console.log(`order ${order.id} created (key and secret saved to ${saved}; they aren't shown again)`);
  console.log(`pay: send exactly ${order.budget_wei} wei of $FLYAI (${order.budget} tokens) from ${order.wallet} to ${order.pay_to}`);
  console.log(`  cast send ${order.token} "transfer(address,uint256)" ${order.pay_to} ${order.budget_wei} --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $KEY`);
  console.log(`then: node examples/order.ts pay --order ${order.id} --tx <hash>`);
} else if (command === "pay") {
  for (let i = 0; ; i++) {
    try {
      const o = await call(`/api/orders/${flag("order")}/pay`, { tx: flag("tx") });
      console.log(`order ${o.id}: ${o.status}, ${o.out} jobs out to miners`);
      break;
    } catch (err) {
      if (!/isn't mined yet|couldn't read the chain/.test(String(err)) || i > 40) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
} else if (command === "watch") {
  const id = flag("order")!;
  const out = flag("out") ?? `results-${id.slice(0, 8)}`;
  mkdirSync(out, { recursive: true });
  const cursorFile = join(out, "cursor.json");
  let after = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")).next : 0;
  for (;;) {
    const page = await call(`/api/orders/${id}/results?after=${after}&limit=1000`);
    for (const row of page.rows) {
      const name = `${String(row.index).padStart(6, "0")}`;
      if (row.output) writeFileSync(join(out, `${name}.out`), Buffer.from(await (await fetch(SERVER + row.output.url)).arrayBuffer()));
      writeFileSync(join(out, `${name}.json`), JSON.stringify(row));
    }
    after = page.next;
    writeFileSync(cursorFile, JSON.stringify({ next: after }));
    process.stdout.write(`\r${page.status}: ${page.settled}/${page.jobs} settled`);
    if ((page.status === "done" || page.status === "ended") && !page.more) break;
    if (!page.more) await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`\noutputs in ${out}/ (index.out = output, index.json = the row: checked_by, error, disputed answers)`);
} else if (command === "add") {
  const jobs = flag("inputs") ? { inputs: await inputsFrom(flag("inputs")!) } : { count: Number(flag("count")) };
  const o = await call(`/api/orders/${flag("order")}/jobs`, jobs, flag("key"));
  console.log(`order ${o.id}: now ${o.jobs} jobs`);
} else if (command === "stop") {
  const o = await call(`/api/orders/${flag("order")}/stop`, {}, flag("key"));
  console.log(`order ${o.id}: ${o.status}; ${o.returned} $FLYAI back to the balance`);
} else {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  void basename;
}
