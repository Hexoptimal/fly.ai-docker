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

// Fly wants something to health-check, and it doubles as a look at what the bridges are doing
createServer((req, res) => {
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
