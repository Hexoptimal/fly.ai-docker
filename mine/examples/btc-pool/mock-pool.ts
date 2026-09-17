/**
 * A tiny Stratum v1 pool for testing the bridge without a real pool: it hands out the genesis block's coinbase as a
 * job (with a made-up previous block, so it's no real block) at a low share difficulty, and checks every submitted
 * share by rebuilding the header from its own copy of the job.
 *
 *   node examples/btc-pool/mock-pool.ts [--port 3333] [--difficulty 0.002]   (a share takes difficulty x 2^32 hashes on average)
 *   then: node examples/btc-pool/bridge.ts --pool stratum+tcp://127.0.0.1:3333 --user test --local
 */
import { createServer, type Server } from "node:net";
import { headerHash, headerPrefix, meets, shareTarget, type PoolJob } from "./stratum.ts";
import { GENESIS_COINBASE, GENESIS_EXTRANONCE1, GENESIS_JOB } from "./vectors.ts";

export interface MockPool { server: Server; port: number; shares: { accepted: number; rejected: number }; newBlock(): void }

export function startMockPool(port: number, difficulty: number): Promise<MockPool> {
  const shares = { accepted: 0, rejected: 0 };
  let height = 1;
  const jobs = new Map<string, PoolJob>();
  const makeJob = (): PoolJob => {
    const j = { ...GENESIS_JOB, id: `job${height}`, prevhash: height.toString(16).padStart(8, "0") + "00".repeat(28) };
    jobs.set(j.id, j);
    return j;
  };
  let current = makeJob();
  const notify = (j: PoolJob) => ({ id: null, method: "mining.notify", params: [j.id, j.prevhash, j.coinb1, j.coinb2, j.branch, j.version, j.nbits, j.ntime, true] });
  const clients = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    const send = (m: unknown) => socket.write(`${JSON.stringify(m)}\n`);
    let buffer = "";
    socket.on("data", (d) => {
      buffer += d.toString();
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const m = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (m.method === "mining.subscribe") {
          send({ id: m.id, result: [[["mining.notify", "mock"]], GENESIS_EXTRANONCE1], error: null });
        } else if (m.method === "mining.authorize") {
          send({ id: m.id, result: true, error: null });
          send({ id: null, method: "mining.set_difficulty", params: [difficulty] });
          send(notify(current));
        } else if (m.method === "mining.submit") {
          const [, jobId, en2, ntime, nonceHex] = m.params as string[];
          const j = jobs.get(jobId);
          const ok = !!j && j.prevhash === current.prevhash && ntime === j.ntime
            && meets(headerHash(headerPrefix(j, GENESIS_EXTRANONCE1, en2), parseInt(nonceHex, 16)), shareTarget(difficulty));
          if (ok) shares.accepted++;
          else shares.rejected++;
          send({ id: m.id, result: ok, error: ok ? null : [23, j && j.prevhash !== current.prevhash ? "Stale" : "Low difficulty share", null] });
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({
    server, port, shares,
    newBlock() {
      height++;
      current = makeJob();
      for (const c of clients) c.write(`${JSON.stringify(notify(current))}\n`);
    },
  })));
}

if (process.argv[1]?.endsWith("mock-pool.ts")) {
  const flag = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const pool = await startMockPool(Number(flag("port", "3333")), Number(flag("difficulty", "0.002")));
  console.log(`mock pool on stratum+tcp://127.0.0.1:${pool.port} (coinbase ${GENESIS_COINBASE.length / 2} bytes)`);
  setInterval(() => console.log(`shares: ${pool.shares.accepted} accepted, ${pool.shares.rejected} rejected`), 10_000);
}
