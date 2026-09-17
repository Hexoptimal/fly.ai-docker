/**
 * Guided setup for mining at a Bitcoin pool with fly.ai compute, for people who don't write code.
 * Double-click start-windows.bat (or start-mac.command), or run: node start.ts
 *
 * It asks a few questions, checks the pool answers, makes the order, opens the payment page in your browser, waits
 * for the payment, and starts the bridge. Answers and the order's key are saved in my-setup.json next to this file,
 * so the next start picks up where you left off. Keep that file private: the key can add jobs to your order and
 * stop it.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { StratumClient } from "./stratum.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SAVED = process.env.BTC_POOL_SETUP ?? `${HERE}my-setup.json`;
const SERVER = process.env.FLYAI_SERVER ?? "https://flyai-mine.fly.dev";
const SITE = SERVER === "https://flyai-mine.fly.dev" ? "https://www.flyaiworld.com" : SERVER;
/** Nonces per job: about 40 seconds on a desktop browser thread, a couple of minutes on a phone. */
const PER_JOB = 100_000_000;
const TIMEOUT_S = 240;

const POOLS = [
  // both checked live on 2026-09-17: they connect, send work, and start share difficulty at 100,000 and 10,000
  { name: "Public Pool (solo mining, no account: your Bitcoin address is the login)", url: "stratum+tcp://public-pool.io:3333", login: "address" },
  { name: "Solo CKPool (solo mining, no account: your Bitcoin address is the login; 2% fee)", url: "stratum+tcp://stratum.ckpool.org:3333", login: "address" },
  { name: "another pool (you have an account there)", url: "", login: "account" },
];

interface Setup { pool: string; user: string; wallet: string; order: string; key: string; server: string }

const rl = createInterface({ input: process.stdin, output: process.stdout });
const say = (text = "") => console.log(text);
const bold = (text: string) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text);
async function ask(question: string, check: (answer: string) => string | null, fallback?: string): Promise<string> {
  for (;;) {
    const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback || "";
    const problem = check(answer);
    if (!problem) return answer;
    say(`  ${problem}`);
  }
}

async function call(path: string, body?: unknown): Promise<any> {
  const res = await fetch(SERVER + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function openInBrowser(url: string): void {
  if (process.env.BTC_POOL_NO_BROWSER) return;
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** Connects to the pool and waits for its first job, so a typo shows up now rather than after paying. */
async function tryPool(url: string, user: string): Promise<boolean> {
  const pool = new StratumClient(url, user);
  pool.on("error", () => {});
  pool.on("close", () => {});
  try {
    const job = new Promise<boolean>((resolve) => { pool.once("job", () => resolve(true)); setTimeout(() => resolve(false), 20_000); });
    await Promise.race([pool.start(), new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 20 seconds")), 20_000))]);
    if (!(await job)) throw new Error("it connected but sent no work");
    say(`  ✓ the pool answered (share difficulty ${pool.difficulty})`);
    return true;
  } catch (err) {
    say(`  ✗ couldn't use that pool: ${err instanceof Error ? err.message : err}`);
    return false;
  } finally {
    pool.close();
  }
}

async function newOrder(): Promise<Setup> {
  say(bold("\n1. The pool"));
  say("A pool sends the work and pays for it. Solo pools pay only if your miners find a whole block (very unlikely);");
  say("pools with accounts pay a little for every share.\n");
  POOLS.forEach((p, i) => say(`  ${i + 1}. ${p.name}`));
  let pool = "";
  let user = "";
  for (;;) {
    const pick = POOLS[Number(await ask("\nWhich pool? Type 1, 2 or 3", (a) => (/^[123]$/.test(a) ? null : "type 1, 2 or 3"), "1")) - 1];
    pool = pick.url || await ask("The pool's Stratum address (it looks like stratum+tcp://host:port)", (a) => (/^stratum\+tcp:\/\/[^\s:]+:\d+$/.test(a) ? null : "it should look like stratum+tcp://pool.example.com:3333"));
    user = pick.login === "address"
      ? await ask("Your Bitcoin address (where the pool pays)", (a) => (/^(bc1[a-z0-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|tb1[a-z0-9]{20,90})$/.test(a) ? null : "that doesn't look like a Bitcoin address (bc1…, 1… or 3…)"))
      : await ask("Your pool login (usually account.worker)", (a) => (a.length ? null : "type your pool login"));
    say("  checking the pool…");
    if (await tryPool(pool, user)) break;
    say("  Let's try again.");
  }

  say(bold("\n2. Your $FLYAI wallet"));
  say("This is the wallet that pays fly.ai miners (MetaMask, Rabby, …, on Robinhood Chain). Copy its address from the wallet.");
  const wallet = await ask("Wallet address", (a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? null : "it should start with 0x and have 40 more characters"));

  say(bold("\n3. The budget"));
  const program = await upload(readFileSync(new URL("../hash-search/hash_search.wasm", import.meta.url)));
  const opening = await upload(openingInput());
  const spec = { kind: "wasm", program, inputs: [opening], timeout_s: TIMEOUT_S, redundancy: 1, keep_open: true };
  const quote = await call("/api/orders/quote", { spec });
  const bid = Number(quote.min_bid);
  say(`Each job searches ${PER_JOB / 1e6} million hashes and costs ${bid} $FLYAI. You pay only for jobs that finish,`);
  say("and whatever isn't used goes back to your balance on the website.");
  const jobs = Number(await ask("How many jobs to buy", (a) => (/^\d+$/.test(a) && Number(a) >= 2 && Number(a) <= 5000 ? null : "a whole number from 2 to 5000"), "100"));
  const budget = String(bid * jobs);
  say(`That's ${Number(budget).toLocaleString("en-US")} $FLYAI.`);

  const order = await call("/api/orders", { wallet, spec, bid: String(bid), budget });
  const setup: Setup = { pool, user, wallet, order: order.id, key: order.order_key, server: SERVER };
  writeFileSync(SAVED, JSON.stringify(setup, null, 2));
  say(`  ✓ order created (saved in my-setup.json)`);
  return setup;
}

async function upload(bytes: Uint8Array): Promise<string> {
  const res = await fetch(`${SERVER}/api/blobs`, { method: "POST", body: bytes as BodyInit });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload: ${json.error ?? res.status}`);
  return json.hash;
}

/** A tiny first job (the genesis block, 1000 nonces): an order has to start with at least one. */
function openingInput(): Buffer {
  const b = Buffer.alloc(116);
  Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d", "hex").copy(b);
  b.writeUInt32LE(2083236000, 76);
  b.writeUInt32LE(1000, 80);
  Buffer.from("00000000ffff0000000000000000000000000000000000000000000000000000", "hex").copy(b, 84);
  return b;
}

async function waitForPayment(setup: Setup): Promise<void> {
  const url = `${SITE}/compute/jobs?pay=${setup.order}`;
  say(bold("\n4. Pay"));
  say("Opening the payment page in your browser. Sign in with the wallet above and press Pay.");
  say(`If it doesn't open, copy this link into your browser:\n  ${url}`);
  openInBrowser(url);
  say("\nWaiting for the payment… (leave this window open)");
  for (;;) {
    const o = await call(`/api/orders/${setup.order}`).catch(() => null);
    if (o?.status === "live") {
      say("  ✓ paid");
      return;
    }
    if (o && o.status !== "unpaid" && o.status !== "expired") throw new Error(`the order is ${o.status}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function mine(setup: Setup): Promise<number> {
  say(bold("\n5. Mining"));
  say("Jobs now go out to fly.ai miners, and shares they find go to your pool. Press Ctrl+C to stop.\n");
  // BTC_POOL_SHARES (tests): small jobs, and stop after that many accepted shares
  const test = process.env.BTC_POOL_SHARES;
  const args = ["--disable-warning=ExperimentalWarning", `${HERE}bridge.ts`, "--pool", setup.pool, "--user", setup.user,
    "--order", setup.order, "--key", setup.key, "--server", setup.server, "--per-job", test ? "2000000" : String(PER_JOB), "--ahead", test ? "3" : "8",
    ...(test ? ["--shares", test] : [])];
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}

// ---- start ---------------------------------------------------------------------------------------------------------
say(bold("fly.ai compute · Bitcoin pool mining"));
say("Your fly.ai order pays miners to search for shares; the pool pays you for them.");
try {
  let setup: Setup | null = existsSync(SAVED) ? JSON.parse(readFileSync(SAVED, "utf8")) : null;
  if (setup && setup.server !== SERVER) setup = null;
  if (setup) {
    const o = await call(`/api/orders/${setup.order}`).catch(() => null);
    if (o?.status === "live") {
      say(`\nYour order ${setup.order.slice(0, 8)} is running, with ${Number(o.budget) - Number(o.spent)} $FLYAI left.`);
      if ((await ask("Keep mining with it? (y/n)", (a) => (/^[yn]$/i.test(a) ? null : "type y or n"), "y")).toLowerCase() === "n") setup = null;
    } else if (o?.status === "unpaid" || o?.status === "expired") {
      say(`\nYour order ${setup.order.slice(0, 8)} isn't paid yet.`);
      if ((await ask("Pay for it now? (n starts over) (y/n)", (a) => (/^[yn]$/i.test(a) ? null : "type y or n"), "y")).toLowerCase() === "y") await waitForPayment(setup);
      else setup = null;
    } else {
      say(`\nYour last order ${o ? `has ${o.status === "done" ? "finished" : "ended"}` : "wasn't found"}. Let's make a new one.`);
      setup = null;
    }
  }
  if (!setup) {
    setup = await newOrder();
    await waitForPayment(setup);
  }
  rl.close();
  const code = await mine(setup);
  if (code !== 0) say("\nMining stopped. If the order ran out, start again to make a new one.");
  process.exit(code);
} catch (err) {
  say(`\nSomething went wrong: ${err instanceof Error ? err.message : err}`);
  rl.close();
  process.exit(1);
}
