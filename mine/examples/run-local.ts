/**
 * Run a WebAssembly job on this machine exactly as a miner does (the same checks, imports and limits), twice, and
 * check both runs give the same bytes. Do this before ordering: if it doesn't agree with itself, miners won't agree.
 *
 *   node examples/run-local.ts <program.wasm> (--index N | --input file) [--out file] [--max-output bytes]
 *
 * Needs Node 22.18+ (run from mine/ or anywhere; paths are resolved from where you are).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { inspectWasm } from "../src/wasmcheck.ts";
import { JobError, runWasm } from "../web/openjob.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const programPath = args[0];
if (!programPath || programPath.startsWith("--")) {
  console.log("usage: node examples/run-local.ts <program.wasm> (--index N | --input file) [--out file] [--max-output bytes]");
  process.exit(1);
}
const program = readFileSync(programPath);
const index = flag("index");
const input = index !== undefined ? new Uint8Array(new Uint32Array([Number(index)]).buffer) : flag("input") ? readFileSync(flag("input")!) : new Uint8Array(0);
const maxOutput = Number(flag("max-output") ?? 4 * 1024 * 1024);

try {
  const inspected = inspectWasm(program);
  console.log(`checks: ok · entry ${inspected.entry} · memory capped at ${inspected.maxPages * 64} KiB · imports ${inspected.imports.map((i) => `${i.module}.${i.name}`).join(", ") || "none"}`);
} catch (err) {
  console.log(`refused: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// the seed miners use for WASI randomness: sha256 of "program:input" (or "#index" for count jobs)
const programHash = createHash("sha256").update(inspectWasm(program).bytes).digest("hex");
const inputKey = index !== undefined ? `#${index}` : createHash("sha256").update(input).digest("hex");
const seed = createHash("sha256").update(`${programHash}:${inputKey}`).digest();

const once = async () => {
  const t = performance.now();
  try {
    const { output } = await runWasm(program, input, seed, maxOutput);
    return { output, ms: performance.now() - t };
  } catch (err) {
    return { error: err instanceof JobError ? err.message : `not a job error: ${err}`, ms: performance.now() - t };
  }
};
const a = await once();
const b = await once();
const same = "output" in a && "output" in b ? Buffer.from(a.output!).equals(Buffer.from(b.output!)) : a.error === b.error;
if ("output" in a && a.output) {
  console.log(`output: ${a.output.length} bytes in ${a.ms.toFixed(0)} ms · first bytes ${Buffer.from(a.output.subarray(0, 32)).toString("hex")}`);
  const out = flag("out");
  if (out) writeFileSync(out, a.output);
} else {
  console.log(`answer: error "${a.error}" in ${a.ms.toFixed(0)} ms`);
}
console.log(same ? "the same twice: miners will agree" : "DIFFERENT on a second run: miners won't agree (sort unordered data, don't use the clock)");
process.exit(same ? 0 : 1);
