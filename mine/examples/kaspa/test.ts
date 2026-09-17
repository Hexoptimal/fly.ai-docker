/**
 * kHeavyHash, checked:
 *   1. the TypeScript implementation against rusty-kaspa's own test vectors (the heavy hash, and the matrix a
 *      pre-pow hash generates, rank check and all)
 *   2. the WGSL shader against the TypeScript implementation, on this machine's GPU: same nonces found, same
 *      hashes, over a range wide enough to have hits
 *   3. the shader's hashrate, to see what a browser would earn
 *   4. the bridge against a mock pool that judges shares with kHeavyHash: nonces keep the pool's extranonce
 *      prefix, and a share is accepted
 *
 *   node examples/kaspa/test.ts            (needs Chrome with WebGPU; skips part 2 and 3 without it)
 *   node examples/kaspa/test.ts --groups 64
 */
import { spawn, type ChildProcess } from "node:child_process";
import { startMockPool } from "./mock-pool.ts";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInput, MAX_HITS, OUTPUT_BYTES, readHits } from "./job.ts";
import { generateMatrix, kHeavyHash, matrixHash, meetsTarget } from "./khh.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

// ---- 1. the reference vectors ------------------------------------------------------------------------------------
const vectors = JSON.parse(readFileSync(join(HERE, "vectors.json"), "utf8"));
const nibbles = (s: string) => Uint8Array.from([...s].map((c) => parseInt(c, 16)));
{
  const got = matrixHash(nibbles(vectors.heavy.matrix), unhex(vectors.heavy.input));
  check("the heavy hash matches rusty-kaspa's vector", hex(got) === vectors.heavy.expected, hex(got).slice(0, 24));
  const mine = generateMatrix(new Uint8Array(32).fill(42));
  const want = nibbles(vectors.generate42.matrix);
  check("the matrix a hash generates matches too, rank check and all", mine.every((x, i) => x === want[i]));
}

// ---- the job both sides run ---------------------------------------------------------------------------------------
const PRE_POW = unhex("6f9a5c4e2d1b8a3f7c0e5d2a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c");
const TIMESTAMP = 1726617600000n;
const PER_THREAD = Number(flag("per-thread") ?? 16);
const GROUPS = Number(flag("groups") ?? 8);
const NONCES = PER_THREAD * 64 * GROUPS;
// tight enough that the whole range's hits fit in one output (about one nonce in 2048 qualifies)
const target = new Uint8Array(32).fill(0xff);
target[31] = 0x00;
target[30] = 0x20;
const matrix = generateMatrix(PRE_POW);
const input = buildInput({ prePowHash: PRE_POW, timestamp: TIMESTAMP, firstNonce: 0n, perThread: PER_THREAD, target, matrix });
writeFileSync(join(HERE, "job.bin"), input);

// what the CPU says the answer is
const expected: { nonce: bigint; hash: Uint8Array }[] = [];
for (let n = 0n; n < BigInt(NONCES); n++) {
  const h = kHeavyHash(matrix, PRE_POW, TIMESTAMP, n);
  if (meetsTarget(h, target)) expected.push({ nonce: n, hash: h });
}

// ---- 2 and 3. the shader on this machine's GPU ---------------------------------------------------------------------
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
let chrome: ChildProcess | null = null;
const server = createServer((req, res) => {
  const name = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "gputest.html";
  const file = join(HERE, name);
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wgsl": "text/plain", ".bin": "application/octet-stream" };
  res.writeHead(200, { "content-type": types[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});
try {
  if (!CHROME) {
    console.log("skip  the shader checks: Chrome not found");
  } else {
    await new Promise<void>((r) => server.listen(8126, "127.0.0.1", r));
    const profile = join(process.env.TEMP ?? "/tmp", `kaspa-gputest-${process.pid}`);
    chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--mute-audio", "--no-first-run",
      "--enable-unsafe-webgpu", "--force_high_performance_gpu", "--remote-debugging-port=9338", "about:blank"], { stdio: "ignore" });
    // drive the page over the DevTools protocol and read its RESULT line
    let tabs: any;
    for (let i = 0; i < 60; i++) {
      try { tabs = await (await fetch("http://127.0.0.1:9338/json")).json(); break; } catch { await sleep(500); }
    }
    const ws = new WebSocket(tabs.find((t: any) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r));
    let id = 0;
    const waiting = new Map<number, (m: any) => void>();
    ws.addEventListener("message", (e: any) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)!(m);
        waiting.delete(m.id);
      }
    });
    const cmd = (method: string, params: any = {}) => new Promise<any>((r) => {
      const i = ++id;
      waiting.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr: string) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await cmd("Page.navigate", { url: `http://127.0.0.1:8126/gputest.html?groups=${GROUPS}` });
    let text = "";
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      text = (await evaluate(`document.getElementById("out").textContent`)) ?? "";
      if (text.includes("RESULT")) break;
    }
    const line = text.split("\n").find((l) => l.startsWith("RESULT")) ?? "";
    if (line.startsWith("RESULT error") || !line) {
      check("the shader runs on this machine's GPU", false, line || text.slice(-160));
    } else {
      const output = unhex(line.slice("RESULT ".length).trim());
      const hits = readHits(output).sort((a, b) => Number(a.nonce - b.nonce));
      check("the shader runs on this machine's GPU", output.length === OUTPUT_BYTES, text.split("\n").find((l) => l.startsWith("adapter")) ?? "");
      const sameNonces = expected.length > 0 && expected.length <= MAX_HITS
        && hits.length === expected.length && hits.every((h, i) => h.nonce === expected[i].nonce);
      check("the shader finds the same nonces as the reference implementation", sameNonces,
        `GPU ${hits.map((h) => h.nonce).join(",") || "none"} · CPU ${expected.map((h) => h.nonce).join(",") || "none"}`);
      const byNonce = new Map(expected.map((h) => [h.nonce, hex(h.hash)]));
      check("and reports the same hashes", hits.length > 0 && hits.every((h) => byNonce.get(h.nonce) === hex(h.hash)),
        hits.length ? hex(hits[0].hash).slice(0, 24) : "no hits");
      const ms = Number((text.split("\n").find((l) => l.startsWith("ms ")) ?? "ms 0").slice(3));
      if (ms > 0) console.log(`      ${NONCES} nonces in ${ms.toFixed(1)} ms = ${(NONCES / ms / 1000).toFixed(2)} MH/s on this GPU`);
    }
  }
} catch (err) {
  check("the shader checks ran", false, String(err));
} finally {
  chrome?.kill();
  server.close();
}

// ---- 4. the bridge against a mock pool ----------------------------------------------------------------------------
{
  const pool = await startMockPool(3336, 0.00000047);
  const bridge = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(HERE, "bridge.ts"),
    "--pool", "stratum+tcp://127.0.0.1:3336", "--user", "kaspa:qqtest.worker", "--local", "--local-nonces", "4000", "--shares", "1"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  bridge.stdout?.on("data", (d) => { out += d.toString(); });
  bridge.stderr?.on("data", (d) => { out += d.toString(); });
  const until = Date.now() + 180_000;
  while (Date.now() < until && pool.shares.accepted < 1) await sleep(500);
  check("the bridge mines against a pool and gets a share accepted", pool.shares.accepted >= 1,
    `${pool.shares.accepted} accepted, ${pool.shares.rejected} rejected${pool.shares.accepted ? "" : `; ${out.slice(-300)}`}`);
  bridge.kill();
  pool.server.close();
}
console.log(failed ? `${failed} FAILED` : "kHeavyHash checks passed");
process.exit(failed ? 1 : 0);
