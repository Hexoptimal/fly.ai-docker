/**
 * The project's mining bridges, always on: one process that keeps the yespower (CPU) and Kaspa (GPU) pool bridges
 * running and answers Fly's health check.
 *
 * Each bridge holds a pool connection, turns the pool's work into house-order jobs for the fleet, checks every hit
 * and submits the good ones. If one dies (a pool drops the connection, say) it is restarted with a backoff; the
 * other carries on.
 *
 * Environment (set as Fly secrets):
 *   ADMIN_TOKEN       the mining server's admin token, to open and feed the house orders
 *   FLYAI_SERVER      the mining server (default https://flyai-mine.fly.dev)
 *   YESPOWER_POOL     stratum URL, e.g. stratum+tcp://yescrypt.mine.zpool.ca:6233 ("" turns this bridge off)
 *   YESPOWER_USER     the payout address the pool pays, plus an optional .worker
 *   YESPOWER_PASS     pool options, e.g. c=BTC for zpool's payout currency
 *   YESPOWER_COIN     which parameters (default yescrypt)
 *   KASPA_POOL        stratum URL, e.g. stratum+tcp://kas.kryptex.network:7011 ("" turns this bridge off)
 *   KASPA_USER        kaspa:address[.worker]
 *   KASPA_PASS        pool options (default x)
 *   YESPOWER_UNITS / KASPA_UNITS
 *     points a settled mining job earns. They are set so that a mining job pays what the brain job it displaces
 *     would have paid for the same seconds of the miner's machine (times PROGRAM_BONUS on top), which is why they
 *     look large: a yespower job is 82 s of one thread, a Kaspa job about 1.5 s of a desktop GPU.
 *
 * GET /mining answers what each pool says it owes our payout address (pending + paid, in the coin and in USD),
 * read from the pools' public stats and cached for 5 minutes. The mining server's /api/mining passes it on.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const env = (k: string, d = "") => process.env[k] ?? d;
const SERVER = env("FLYAI_SERVER", "https://flyai-mine.fly.dev");
const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);

interface Bridge {
  name: string;
  script: string;
  args: string[];
  child?: ChildProcess;
  restarts: number;
  startedAt: number;
}

const bridges: Bridge[] = [];
if (env("YESPOWER_POOL") && env("YESPOWER_USER")) {
  bridges.push({
    name: "yespower",
    script: fileURLToPath(new URL("../examples/yespower-pool/bridge.ts", import.meta.url)),
    args: ["--pool", env("YESPOWER_POOL"), "--user", env("YESPOWER_USER"), "--pass", env("YESPOWER_PASS", "x"),
      "--coin", env("YESPOWER_COIN", "yescrypt"), "--server", SERVER, "--per-job", env("YESPOWER_PER_JOB", "20000"),
      "--ahead", env("YESPOWER_AHEAD", "16"), "--units", env("YESPOWER_UNITS", "84")],
    restarts: 0, startedAt: 0,
  });
}
if (env("KASPA_POOL") && env("KASPA_USER")) {
  bridges.push({
    name: "kaspa",
    script: fileURLToPath(new URL("../examples/kaspa/bridge.ts", import.meta.url)),
    args: ["--pool", env("KASPA_POOL"), "--user", env("KASPA_USER"), "--pass", env("KASPA_PASS", "x"),
      "--server", SERVER, "--groups", env("KASPA_GROUPS", "1024"), "--per-thread", env("KASPA_PER_THREAD", "64"),
      "--ahead", env("KASPA_AHEAD", "8"), "--units", env("KASPA_UNITS", "39")],
    restarts: 0, startedAt: 0,
  });
}
if (!bridges.length) log("no bridge is configured: set YESPOWER_POOL/USER or KASPA_POOL/USER");

function run(b: Bridge): void {
  b.startedAt = Date.now();
  b.child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", b.script, ...b.args], {
    env: { ...process.env, ADMIN_TOKEN: env("ADMIN_TOKEN") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  log(`${b.name}: started`);
  b.child.on("exit", (code) => {
    const ran = (Date.now() - b.startedAt) / 1000;
    b.restarts++;
    // a bridge that dies at once is misconfigured: back off rather than hammer the pool
    const wait = ran > 120 ? 5_000 : Math.min(60_000, 5_000 * b.restarts);
    log(`${b.name}: exited (${code}) after ${ran.toFixed(0)}s; restarting in ${wait / 1000}s`);
    setTimeout(() => run(b), wait);
  });
}
for (const b of bridges) run(b);

// ---- what the pools owe us -------------------------------------------------------------------------------
// Each pool's own public stats for our payout address, so the numbers are the pool's, not our share counts.
interface Earned {
  name: string; algo: string; coin: string; pool: string; address: string;
  pending: number | null; paid: number | null; earned: number | null; usd: number | null; error?: string;
}
const COINGECKO: Record<string, string> = { BTC: "bitcoin", KAS: "kaspa" };
const payout = (user: string) => user.split(".")[0];

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function poolEarned(name: string, algo: string, poolUrl: string, user: string, pass: string): Promise<Earned> {
  const host = poolUrl.replace(/^stratum\+\w+:\/\//, "").split(":")[0];
  const address = payout(user);
  const base = { name, algo, pool: host, address };
  try {
    if (host.endsWith("zpool.ca")) {
      // zpool pays in the currency named by c= in the password; amounts are in that coin
      const coin = /(?:^|,)c=([A-Z]+)/.exec(pass)?.[1] ?? "BTC";
      const w = await getJson(`https://zpool.ca/api/wallet?address=${encodeURIComponent(address)}`);
      if (w.error) throw new Error(String(w.error));
      const pending = Number(w.unpaid ?? w.balance ?? 0) + Number(w.unsold ?? 0);
      const paid = Number(w.paidtotal ?? 0);
      return { ...base, coin, pending, paid, earned: pending + paid, usd: null };
    }
    if (host.endsWith("herominers.com")) {
      // HeroMiners amounts are in the coin's smallest unit (1e8 for Kaspa)
      const coin = host.startsWith("kaspa") ? "KAS" : host.split(".")[0].toUpperCase();
      const w = await getJson(`https://${host}/api/stats_address?address=${encodeURIComponent(address)}`);
      const pending = Number(w.stats?.balance ?? 0) / 1e8;
      const paid = Number(w.stats?.paid ?? 0) / 1e8;
      return { ...base, coin, pending, paid, earned: pending + paid, usd: null };
    }
    return { ...base, coin: "?", pending: null, paid: null, earned: null, usd: null, error: "this pool's stats aren't read yet" };
  } catch (err) {
    return { ...base, coin: "?", pending: null, paid: null, earned: null, usd: null, error: (err as Error).message };
  }
}

let earnedCache: { at: number; body: unknown } | null = null;
async function mining(): Promise<unknown> {
  if (earnedCache && Date.now() - earnedCache.at < 300_000) return earnedCache.body;
  const coins = await Promise.all([
    ...(env("YESPOWER_POOL") && env("YESPOWER_USER") ? [poolEarned("yespower", env("YESPOWER_COIN", "yescrypt"), env("YESPOWER_POOL"), env("YESPOWER_USER"), env("YESPOWER_PASS", "x"))] : []),
    ...(env("KASPA_POOL") && env("KASPA_USER") ? [poolEarned("kaspa", "kheavyhash", env("KASPA_POOL"), env("KASPA_USER"), env("KASPA_PASS", "x"))] : []),
  ]);
  const ids = [...new Set(coins.map((c) => COINGECKO[c.coin]).filter(Boolean))];
  const prices = ids.length
    ? await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`).catch(() => ({}))
    : {};
  for (const c of coins) {
    const price = prices[COINGECKO[c.coin]]?.usd;
    if (c.earned !== null && typeof price === "number") c.usd = c.earned * price;
  }
  const body = { updated_at: new Date().toISOString(), coins };
  earnedCache = { at: Date.now(), body };
  return body;
}

// Fly wants something to health-check, and it doubles as a look at what the bridges are doing
createServer((req, res) => {
  if (req.url?.startsWith("/mining")) {
    void mining().then((body) => {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    }, (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    server: SERVER,
    bridges: bridges.map((b) => ({ name: b.name, running: !!b.child && b.child.exitCode === null, restarts: b.restarts, uptime_s: Math.round((Date.now() - b.startedAt) / 1000) })),
  }));
}).listen(Number(env("PORT", "8080")), () => log(`health on :${env("PORT", "8080")} · ${bridges.map((b) => b.name).join(", ") || "nothing"}`));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    for (const b of bridges) b.child?.kill();
    process.exit(0);
  });
}
