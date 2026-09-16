/**
 * What a buyer's WebAssembly module may be, checked on upload by the server and again by every miner before it runs
 * one (a miner doesn't have to trust the server). Pure TypeScript with no Node or DOM APIs, so both sides run it.
 *
 * The module gets nothing but the imports below: no network, files, clock or JavaScript. It runs in a fresh worker
 * that is killed at the job's time limit. This check covers what a sandbox alone doesn't:
 *
 *  - imports: functions only, from `flyai` (input_len, input_read, output) or `wasi_snapshot_preview1` (a
 *    deterministic subset; see web/openjob.ts). Imported memories, tables and globals are refused.
 *  - memory: at most one, 32-bit and not shared (no threads). Its maximum is rewritten to MAX_PAGES (or lower), so a
 *    module can't grow past it and take down the miner's tab: `memory.grow` just fails. The minimum must fit too.
 *  - tables: their maximum is capped the same way (MAX_TABLE elements).
 *  - exports: `memory`, and `run` (flyai) or `_start` (WASI).
 *  - size: at most MAX_MODULE_BYTES.
 *
 * Nondeterminism (relaxed SIMD, NaN bit patterns) isn't refused: miners who disagree just don't settle a job, and the
 * buyer sees the disputed answers.
 */

export const MAX_MODULE_BYTES = 8 * 1024 * 1024;
/** 64 KiB pages: 4096 is 256 MiB */
export const MAX_PAGES = 4096;
export const MAX_TABLE = 1_000_000;

export const FLYAI_IMPORTS = ["input_len", "input_read", "output"] as const;
export const WASI = "wasi_snapshot_preview1";

export class WasmError extends Error {}

export interface Inspected {
  /** the module with memory and table maximums capped: what miners run */
  bytes: Uint8Array;
  entry: "run" | "_start";
  /** memory maximum after the cap, in pages */
  maxPages: number;
  imports: { module: string; name: string }[];
}

class Reader {
  pos = 0;
  readonly b: Uint8Array;
  readonly end: number;
  constructor(b: Uint8Array, end = b.length) {
    this.b = b;
    this.end = end;
  }
  byte(): number {
    if (this.pos >= this.end) throw new WasmError("module ends early");
    return this.b[this.pos++];
  }
  u32(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return result;
      shift += 7;
    }
    throw new WasmError("bad LEB128 number");
  }
  name(): string {
    const len = this.u32();
    if (this.pos + len > this.end) throw new WasmError("name runs past its section");
    let s: string;
    try {
      s = new TextDecoder("utf-8", { fatal: true }).decode(this.b.subarray(this.pos, this.pos + len));
    } catch {
      throw new WasmError("a name isn't UTF-8");
    }
    this.pos += len;
    return s;
  }
}

const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
};

/** limits: flags 0 (min) or 1 (min, max); shared (2, 3) and 64-bit (4+) are refused */
function limits(r: Reader, what: string): { min: number; max: number | null } {
  const flags = r.byte();
  if (flags & 0x02) throw new WasmError(`${what} is shared (threads aren't supported)`);
  if (flags & ~0x01) throw new WasmError(`${what} is 64-bit or has unknown flags`);
  const min = r.u32();
  return { min, max: flags & 1 ? r.u32() : null };
}

const cappedLimits = (min: number, max: number | null, cap: number, what: string): number[] => {
  if (min > cap) throw new WasmError(`${what} starts at ${min}, over the limit of ${cap}`);
  const m = Math.min(max ?? cap, cap);
  return [0x01, ...leb(min), ...leb(m)];
};

/**
 * Check a module and cap its limits. Whatever the bytes, this only ever returns or throws WasmError, in time linear in
 * the size (one pass, no recursion), holding at most one copy of the module: src/programtest.ts fuzzes it.
 */
export function inspectWasm(bytes: Uint8Array): Inspected {
  try {
    return inspect(bytes);
  } catch (err) {
    if (err instanceof WasmError) throw err;
    throw new WasmError("malformed module"); // belt and braces: nothing else escapes to the caller
  }
}

function inspect(bytes: Uint8Array): Inspected {
  if (bytes.length > MAX_MODULE_BYTES) throw new WasmError(`module is ${bytes.length} bytes; the limit is ${MAX_MODULE_BYTES}`);
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (bytes.length < 8 || magic.some((b, i) => bytes[i] !== b)) throw new WasmError("not a WebAssembly module (version 1)");

  // the copy is built from slices of the original, not byte by byte
  const out: Uint8Array[] = [Uint8Array.from(magic)];
  const imports: { module: string; name: string }[] = [];
  const exports = new Map<string, number>();
  let memories = 0;
  let maxPages = MAX_PAGES;
  const r = new Reader(bytes);
  r.pos = 8;
  while (r.pos < bytes.length) {
    const header = r.pos;
    const id = r.byte();
    const size = r.u32();
    const start = r.pos;
    const end = start + size;
    if (end > bytes.length) throw new WasmError("section runs past the end of the module");
    const s = new Reader(bytes, end);
    s.pos = start;
    let body: number[] | null = null; // a rewritten section body (tables, memory: a few bytes), or null to copy it as is

    if (id > 12 && id !== 0) throw new WasmError(`unknown section ${id}`);
    if (id === 2) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const module = s.name();
        const name = s.name();
        const kind = s.byte();
        if (kind !== 0) throw new WasmError(`import ${module}.${name} isn't a function; only functions can be imported`);
        s.u32();
        if (module === "flyai" ? !(FLYAI_IMPORTS as readonly string[]).includes(name) : module !== WASI) {
          throw new WasmError(`import ${module}.${name} isn't available; use flyai.{${FLYAI_IMPORTS.join(", ")}} or ${WASI}`);
        }
        imports.push({ module, name });
      }
    } else if (id === 4) {
      const n = s.u32();
      body = [...leb(n)];
      for (let i = 0; i < n; i++) {
        const ref = s.byte();
        if (ref !== 0x70 && ref !== 0x6f) throw new WasmError("unknown table type");
        const { min, max } = limits(s, "a table");
        body.push(ref, ...cappedLimits(min, max, MAX_TABLE, "a table"));
      }
    } else if (id === 5) {
      const n = s.u32();
      memories += n;
      if (memories > 1) throw new WasmError("more than one memory");
      body = [...leb(n)];
      for (let i = 0; i < n; i++) {
        const { min, max } = limits(s, "the memory");
        maxPages = Math.min(max ?? MAX_PAGES, MAX_PAGES);
        body.push(...cappedLimits(min, max, MAX_PAGES, "the memory (pages)"));
      }
    } else if (id === 7) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const name = s.name();
        const kind = s.byte();
        s.u32();
        exports.set(name, kind);
      }
    }
    if (body) {
      if (s.pos !== end) throw new WasmError(`section ${id} has trailing bytes`);
      out.push(Uint8Array.from([id, ...leb(body.length), ...body]));
    } else {
      out.push(bytes.subarray(header, end));
    }
    r.pos = end;
  }

  if (memories === 0 || exports.get("memory") !== 2) throw new WasmError("the module must define and export its memory as `memory`");
  const entry = exports.get("run") === 0 ? "run" : exports.get("_start") === 0 ? "_start" : null;
  if (!entry) throw new WasmError("the module must export a function `run` (flyai) or `_start` (WASI)");
  const total = out.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of out) {
    joined.set(part, at);
    at += part.length;
  }
  return { bytes: joined, entry, maxPages, imports };
}

/** A WGSL compute shader's own limits; the shader is compiled by the miner's GPU, not here. */
export const MAX_SHADER_BYTES = 1024 * 1024;
export const MAX_DISPATCH = 1 << 20;

export function inspectWgsl(bytes: Uint8Array): string {
  if (bytes.length > MAX_SHADER_BYTES) throw new WasmError(`shader is ${bytes.length} bytes; the limit is ${MAX_SHADER_BYTES}`);
  let code: string;
  try {
    code = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WasmError("a WGSL shader must be UTF-8 text");
  }
  if (!/@compute/.test(code) || !/fn\s+main\s*\(/.test(code)) throw new WasmError("a WGSL shader needs a @compute entry point named main");
  return code;
}
