/**
 * Kaspa's flavour of Stratum: newline-delimited JSON-RPC, as the pools and kaspa-stratum-bridge speak it.
 *
 * It differs from Bitcoin's: a job carries the pre-pow hash and timestamp rather than coinbase parts, the nonce is
 * 64 bits, and the pool may hand out an extranonce prefix that the miner must keep at the top of every nonce it
 * tries. Jobs come in two shapes - four u64 numbers, or one 80-character hex string - and both are accepted here.
 */
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";

export interface KaspaJob {
  id: string;
  /** 32 bytes */
  prePowHash: Uint8Array;
  timestamp: bigint;
}

const leBytes = (words: bigint[]): Uint8Array => {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  words.forEach((w, i) => view.setBigUint64(i * 8, BigInt.asUintN(64, w), true));
  return out;
};

/** A job as mining.notify sends it, either shape. */
export function parseNotify(params: any[]): KaspaJob {
  const id = String(params[0]);
  if (Array.isArray(params[1])) {
    return { id, prePowHash: leBytes(params[1].map((x: any) => BigInt(x))), timestamp: BigInt(params[2] ?? 0) };
  }
  // the "big job" shape: 64 hex characters of pre-pow hash, then the timestamp as a little-endian u64 of its bytes
  const hex = String(params[1]);
  const bytes = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  const words = [0, 1, 2, 3].map((i) => new DataView(bytes.buffer).getBigUint64(i * 8, false));
  const timestamp = new DataView(bytes.buffer).getBigUint64(32, true);
  return { id, prePowHash: leBytes(words), timestamp };
}

export class KaspaStratum extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  /** the nonce prefix the pool reserved, as hex; the miner owns the rest */
  extranonce = "";
  difficulty = 1;

  private url: string;
  private user: string;
  private pass: string;

  constructor(url: string, user: string, pass = "x") {
    super();
    this.url = url;
    this.user = user;
    this.pass = pass;
  }

  start(): Promise<void> {
    const { hostname, port } = new URL(this.url.replace(/^stratum\+tcp:/, "http:"));
    return new Promise((resolve, reject) => {
      const socket = connect({ host: hostname, port: Number(port) }, async () => {
        this.socket = socket;
        try {
          await this.call("mining.subscribe", ["fly.ai-compute/1.0.0", "EthereumStratum/1.0.0"]);
          await this.call("mining.authorize", [this.user, this.pass]);
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      });
      socket.on("data", (d) => this.onData(d.toString()));
      socket.on("error", (err) => this.emit("error", err));
      socket.on("close", () => this.emit("close"));
      socket.setTimeout(600_000, () => socket.destroy());
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id !== null && m.id !== undefined && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
        continue;
      }
      if (m.method === "mining.notify") this.emit("job", parseNotify(m.params));
      else if (m.method === "mining.set_difficulty") this.emit("difficulty", (this.difficulty = Number(m.params[0])));
      else if (m.method === "set_extranonce" || m.method === "mining.set_extranonce") {
        this.extranonce = String(m.params[0] ?? "");
        this.emit("extranonce", this.extranonce);
      }
    }
  }

  private call(method: string, params: unknown[]): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      });
      this.socket!.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    });
  }

  /** Send a share. The nonce goes as the full 16 hex characters, extranonce prefix already in place. */
  async submit(jobId: string, nonce: bigint): Promise<{ result: unknown; error?: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ result: false, error: "timed out" }), 30_000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve({ result: m.result, error: m.error });
      });
      this.socket!.write(`${JSON.stringify({ id, jsonrpc: "2.0", method: "mining.submit", params: [this.user, jobId, nonce.toString(16).padStart(16, "0")] })}\n`);
    });
  }

  close(): void {
    this.socket?.end();
  }
}

/** A nonce that keeps the pool's extranonce prefix at the top. */
export function withExtranonce(extranonce: string, counter: bigint): bigint {
  if (!extranonce) return BigInt.asUintN(64, counter);
  const bits = extranonce.length * 4;
  const prefix = BigInt(`0x${extranonce}`) << BigInt(64 - bits);
  const mask = (1n << BigInt(64 - bits)) - 1n;
  return BigInt.asUintN(64, prefix | (counter & mask));
}
