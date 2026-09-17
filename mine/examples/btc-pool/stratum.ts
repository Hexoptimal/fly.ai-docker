/**
 * Bitcoin pool mining over Stratum v1, the parts a bridge needs: a client for the pool's TCP connection, turning a
 * pool job into block headers, targets from difficulty, and checking a nonce before it's sent back.
 *
 * Byte orders, which is where Stratum code usually goes wrong:
 *   - a header is serialized little-endian: version, prevhash, merkle root, time, bits, nonce
 *   - `prevhash` in mining.notify has each 4-byte word byte-swapped, so it's swapped back word by word (checked
 *     against a live pool and the chain tip on 2026-09-17: see vectors.ts)
 *   - `version`, `nbits` and `ntime` in mining.notify are big-endian hex, so they're reversed into the header
 *   - the coinbase is coinb1 + extranonce1 + extranonce2 + coinb2; its double SHA-256, folded with the merkle
 *     branch (each step sha256d(root || branch)), is the merkle root exactly as the header holds it
 *   - a block hash is shown reversed ("display order"), and that reversed number is compared to the target
 * test.ts checks all of this against Bitcoin's genesis block, block 1, and a live pool's prevhash.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";

export const sha256d = (b: Uint8Array): Buffer => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hex = (s: string) => Buffer.from(s, "hex");
const reversed = (s: string) => Buffer.from(s, "hex").reverse();
/** Stratum's prevhash to header byte order: each 32-bit word byte-swapped. */
export const prevhashBytes = (s: string) => {
  const b = hex(s);
  for (let i = 0; i + 4 <= b.length; i += 4) b.subarray(i, i + 4).reverse();
  return b;
};

/** mining.notify, named. */
export interface PoolJob {
  id: string;
  prevhash: string;
  coinb1: string;
  coinb2: string;
  branch: string[];
  version: string;
  nbits: string;
  ntime: string;
}

export const jobFromNotify = (p: unknown[]): PoolJob => ({
  id: String(p[0]), prevhash: String(p[1]), coinb1: String(p[2]), coinb2: String(p[3]),
  branch: (p[4] as string[]) ?? [], version: String(p[5]), nbits: String(p[6]), ntime: String(p[7]),
});

export function merkleRoot(coinbase: Buffer, branch: string[]): Buffer {
  let root = sha256d(coinbase);
  for (const b of branch) root = sha256d(Buffer.concat([root, hex(b)]));
  return root;
}

/** The first 76 bytes of the header (everything but the nonce) for one extranonce2. */
export function headerPrefix(job: PoolJob, extranonce1: string, extranonce2: string): Buffer {
  const coinbase = hex(job.coinb1 + extranonce1 + extranonce2 + job.coinb2);
  return Buffer.concat([reversed(job.version), prevhashBytes(job.prevhash), merkleRoot(coinbase, job.branch), reversed(job.ntime), reversed(job.nbits)]);
}

/** A header's hash in display order (the number compared with targets). */
export function headerHash(prefix: Buffer, nonce: number): Buffer {
  const n = Buffer.alloc(4);
  n.writeUInt32LE(nonce >>> 0);
  return sha256d(Buffer.concat([prefix, n])).reverse();
}

const TWO256 = 1n << 256n;
const DIFF1 = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;
const toBytes = (n: bigint) => hex(n.toString(16).padStart(64, "0"));

/** The share target for a pool difficulty (pool difficulty 1 is Bitcoin's difficulty-1 target). */
export function shareTarget(difficulty: number): Buffer {
  // difficulty can be fractional; scale to keep 1e-8 precision in integer math
  const scaled = BigInt(Math.max(1, Math.round(difficulty * 1e8)));
  const t = (DIFF1 * 100_000_000n) / scaled;
  return toBytes(t >= TWO256 ? TWO256 - 1n : t);
}

/** The block target the header's nbits encodes. */
export function blockTarget(nbits: string): Buffer {
  const bits = parseInt(nbits, 16);
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0xffffff);
  return toBytes(exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3)));
}

export const meets = (hash: Buffer, target: Buffer) => Buffer.compare(hash, target) <= 0;

/**
 * How many bytes the pool expects for extranonce2. Stratum doesn't say, but the coinbase transaction only parses
 * (inputs, outputs, locktime, nothing left over) with the right length.
 */
export function extranonce2Bytes(job: PoolJob, extranonce1: string): number {
  for (const n of [8, 4, 16, 2, 1, 12]) {
    if (parsesAsTransaction(hex(job.coinb1 + extranonce1 + "00".repeat(n) + job.coinb2))) return n;
  }
  throw new Error("couldn't tell the extranonce size from the coinbase; pass --extranonce2-bytes");
}

function parsesAsTransaction(tx: Buffer): boolean {
  let at = 0;
  const need = (n: number) => { if (at + n > tx.length) throw new Error("short"); };
  const varint = () => {
    need(1);
    const b = tx[at++];
    if (b < 0xfd) return b;
    const size = b === 0xfd ? 2 : b === 0xfe ? 4 : 8;
    need(size);
    const v = size === 8 ? Number(tx.readBigUInt64LE(at)) : tx.readUIntLE(at, size);
    at += size;
    return v;
  };
  try {
    need(4); at += 4; // version
    const inputs = varint();
    if (inputs !== 1) return false; // a coinbase has one input
    need(36); at += 36;
    const script = varint();
    if (script < 2 || script > 100) return false; // consensus: a coinbase script is 2-100 bytes
    need(script + 4); at += script + 4;
    const outputs = varint();
    if (outputs < 1) return false;
    for (let i = 0; i < outputs; i++) { need(8); at += 8; const len = varint(); need(len); at += len; }
    need(4); at += 4; // locktime
    return at === tx.length;
  } catch {
    return false;
  }
}

/**
 * A Stratum v1 client: subscribe, authorize, then `job` events for each mining.notify (with `clean` when the
 * pool says earlier jobs are stale) and `difficulty` events. submit() resolves with the pool's verdict.
 */
export class StratumClient extends EventEmitter {
  extranonce1 = "";
  difficulty = 1;
  private socket: Socket | null = null;
  private nextId = 1;
  private waiting = new Map<number, (m: { result: unknown; error: unknown }) => void>();

  private readonly url: string;
  private readonly user: string;
  private readonly pass: string;

  constructor(url: string, user: string, pass = "x") {
    super();
    this.url = url;
    this.user = user;
    this.pass = pass;
  }

  async start(): Promise<void> {
    const u = new URL(this.url.replace(/^stratum\+tcp:/, "tcp:"));
    const socket = connect(Number(u.port), u.hostname);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.setKeepAlive(true, 30_000);
    let buffer = "";
    socket.on("data", (d) => {
      buffer += d.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    socket.on("close", () => this.emit("close"));
    socket.on("error", (err) => this.emit("error", err));
    const sub = await this.call("mining.subscribe", ["flyai-compute-bridge/0.1"]) as unknown[];
    this.extranonce1 = String(sub[1] ?? "");
    const ok = await this.call("mining.authorize", [this.user, this.pass]);
    if (ok === false) throw new Error("the pool refused the username/password");
  }

  submit(jobId: string, extranonce2: string, ntime: string, nonce: number): Promise<{ result: unknown; error: unknown }> {
    return this.request("mining.submit", [this.user, jobId, extranonce2, ntime, (nonce >>> 0).toString(16).padStart(8, "0")]);
  }

  close(): void {
    this.socket?.destroy();
  }

  private call(method: string, params: unknown[]): Promise<unknown> {
    return this.request(method, params).then((m) => {
      if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`);
      return m.result;
    });
  }

  private request(method: string, params: unknown[]): Promise<{ result: unknown; error: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.socket!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private onLine(line: string): void {
    let m: { id?: number | null; method?: string; params?: unknown[]; result?: unknown; error?: unknown };
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === "mining.notify" && m.params) {
      this.emit("job", jobFromNotify(m.params), m.params[8] !== false);
    } else if (m.method === "mining.set_difficulty" && m.params) {
      this.difficulty = Number(m.params[0]);
      this.emit("difficulty", this.difficulty);
    } else if (m.method === "client.get_version" && m.id != null) {
      this.socket!.write(`${JSON.stringify({ id: m.id, result: "flyai-compute-bridge/0.1", error: null })}\n`);
    } else if (m.method === "client.show_message" && m.params) {
      this.emit("message", String(m.params[0]));
    } else if (m.method === "client.reconnect") {
      this.emit("message", "the pool asked to reconnect; restart the bridge");
    } else if (m.id != null && this.waiting.has(m.id)) {
      this.waiting.get(m.id)!({ result: m.result, error: m.error ?? null });
      this.waiting.delete(m.id);
    }
  }
}
