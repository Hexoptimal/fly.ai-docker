// Hashrate of khh.wgsl on this machine's GPU: node examples/kaspa/bench.ts [--groups 1024] [--per-thread 64]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInput } from "./job.ts";
import { generateMatrix } from "./khh.ts";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const GROUPS = Number(flag("groups") ?? 1024);
const PER_THREAD = Number(flag("per-thread") ?? 64);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prePow = new Uint8Array(32).fill(7);
const target = new Uint8Array(32); // nothing qualifies: the whole range is walked
writeFileSync(join(HERE, "job.bin"), buildInput({ prePowHash: prePow, timestamp: 1n, firstNonce: 0n, perThread: PER_THREAD, target, matrix: generateMatrix(prePow) }));
const server = createServer((req, res) => {
  const file = join(HERE, (req.url ?? "/").split("?")[0].replace(/^\//, "") || "gputest.html");
  if (!existsSync(file)) return void res.writeHead(404).end();
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wgsl": "text/plain", ".bin": "application/octet-stream" };
  res.writeHead(200, { "content-type": types[extname(file)] ?? "text/plain" }).end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(8128, "127.0.0.1", r));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new",
  `--user-data-dir=${join(process.env.TEMP ?? "/tmp", `kaspa-bench-${process.pid}`)}`, "--mute-audio", "--no-first-run",
  "--enable-unsafe-webgpu", "--force_high_performance_gpu", "--remote-debugging-port=9340", "about:blank"], { stdio: "ignore" });
let tabs: any;
for (let i = 0; i < 60; i++) { try { tabs = await (await fetch("http://127.0.0.1:9340/json")).json(); break; } catch { await sleep(500); } }
const ws = new WebSocket(tabs.find((t: any) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waiting = new Map<number, (m: any) => void>();
ws.addEventListener("message", (e: any) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); } });
const cmd = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr: string) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await cmd("Page.navigate", { url: `http://127.0.0.1:8128/gputest.html?groups=${GROUPS}` });
let text = "";
for (let i = 0; i < 120; i++) { await sleep(1000); text = (await ev(`document.getElementById("out").textContent`)) ?? ""; if (text.includes("RESULT")) break; }
const ms = Number((text.split("\n").find((l) => l.startsWith("ms ")) ?? "ms 0").slice(3));
const nonces = GROUPS * 64 * PER_THREAD;
console.log(text.split("\n").find((l) => l.startsWith("adapter")) ?? "");
console.log(`${nonces.toLocaleString("en-US")} nonces in ${ms.toFixed(1)} ms = ${(nonces / ms / 1000).toFixed(2)} MH/s`);
chrome.kill(); server.close(); process.exit(0);
