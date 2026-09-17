/**
 * A tiny Kaspa-flavoured Stratum pool that judges shares with kHeavyHash, for testing the bridge without a real
 * pool. Its jobs carry a made-up pre-pow hash, so no share is ever a real block.
 *
 *   node examples/kaspa/mock-pool.ts [--port 3336] [--difficulty 0.00000047]
 *   then: node examples/kaspa/bridge.ts --pool stratum+tcp://127.0.0.1:3336 --user kaspa:test --local
 */
import { createServer, type Server } from "node:net";
import { generateMatrix, kHeavyHash, meetsTarget, targetFromDifficulty } from "./khh.ts";

export interface MockPool { server: Server; port: number; shares: { accepted: number; rejected: number }; newJob(): void }

export function startMockPool(port: number, difficulty: number): Promise<MockPool> {
  const shares = { accepted: 0, rejected: 0 };
  let height = 1;
  const target = targetFromDifficulty(difficulty);
  const jobs = new Map<string, { prePowHash: Uint8Array; timestamp: bigint; matrix: Uint8Array }>();
  const makeJob = () => {
    const prePowHash = new Uint8Array(32).fill(height & 0xff);
    prePowHash[0] = height & 0xff;
    prePowHash[1] = (height >> 8) & 0xff;
    const job = { prePowHash, timestamp: BigInt(1726617600000 + height), matrix: generateMatrix(prePowHash) };
    jobs.set(`job${height}`, job);
    return { id: `job${height}`, ...job };
  };
  let current = makeJob();
  const notify = (j: typeof current) => {
    const words = [0, 1, 2, 3].map((i) => new DataView(j.prePowHash.buffer, j.prePowHash.byteOffset).getBigUint64(i * 8, true).toString());
    return { id: null, method: "mining.notify", params: [j.id, words, Number(j.timestamp)] };
  };
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
          send({ id: m.id, result: [true, "EthereumStratum/1.0.0"], error: null });
        } else if (m.method === "mining.authorize") {
          send({ id: m.id, result: true, error: null });
          send({ id: null, method: "set_extranonce", params: ["ab"] });
          send({ id: null, method: "mining.set_difficulty", params: [difficulty] });
          send(notify(current));
        } else if (m.method === "mining.submit") {
          const [, jobId, nonceHex] = m.params as string[];
          const j = jobs.get(jobId);
          let ok = false;
          if (j && jobId === current.id) {
            const nonce = BigInt(`0x${nonceHex}`);
            // the pool checks the nonce carries the extranonce prefix it handed out, as a real one does
            const prefixOk = nonceHex.toLowerCase().startsWith("ab");
            ok = prefixOk && meetsTarget(kHeavyHash(j.matrix, j.prePowHash, j.timestamp, nonce), target);
          }
          if (ok) shares.accepted++;
          else shares.rejected++;
          send({ id: m.id, result: ok, error: ok ? null : [23, j ? "Low difficulty share" : "Job not found", null] });
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({
    server, port, shares,
    newJob() {
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
  const pool = await startMockPool(Number(flag("port", "3336")), Number(flag("difficulty", "0.00000047")));
  console.log(`mock Kaspa pool on stratum+tcp://127.0.0.1:${pool.port}`);
  setInterval(() => console.log(`shares: ${pool.shares.accepted} accepted, ${pool.shares.rejected} rejected`), 10_000);
}
