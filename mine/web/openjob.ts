/**
 * Running a buyer's program: a WebAssembly module on the CPU, or a WGSL compute shader on the GPU. Shared by the miner's
 * worker (web/open.worker.ts) and the tests; no DOM, and WebGPU only when a shader runs.
 *
 * WASM, two ways to talk to the world (a module uses one or both):
 *
 *   flyai.input_len() -> i32               the input's size in bytes
 *   flyai.input_read(ptr: i32)             copy the whole input into memory at ptr
 *   flyai.output(ptr: i32, len: i32)       append len bytes to the output
 *   export run()                           the entry point
 *
 *   wasi_snapshot_preview1 (for wasm32-wasip1 programs): stdin is the input, stdout is the output, stderr is dropped,
 *   no arguments or environment, no files, the clock always reads 0, and random_get is seeded from the program and
 *   input hashes, so every miner gets the same bytes. Anything else returns ENOSYS. The entry point is _start.
 *
 * Output is capped at `maxOutput` bytes. Traps and exits with a nonzero code become errors, which are answers too:
 * miners who hit the same trap agree on it.
 */
import { inspectWasm, MAX_DISPATCH, type Inspected } from "../src/wasmcheck.ts";

export class JobError extends Error {}

class Exit {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

const ENOSYS = 52;
const EBADF = 8;
const ESPIPE = 70;

/** xorshift128+ from a 32-byte seed: deterministic random_get */
function seeded(seed: Uint8Array): (n: number) => Uint8Array {
  const v = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
  let s0 = v.getBigUint64(0, true) | 1n;
  let s1 = v.getBigUint64(8, true) | 2n;
  const M = (1n << 64n) - 1n;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 8) {
      let x = s0;
      const y = s1;
      s0 = y;
      x = (x ^ (x << 23n)) & M;
      s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
      let r = (s1 + y) & M;
      for (let k = 0; k < 8 && i + k < n; k++, r >>= 8n) out[i + k] = Number(r & 255n);
    }
    return out;
  };
}

export interface WasmRun {
  output: Uint8Array;
}

/**
 * Run a module on an input. `seed` is 32 bytes (the program and input hashes combined). Throws JobError for anything
 * the program did wrong: bad module, trap, nonzero exit, output over the cap.
 */
export async function runWasm(programBytes: Uint8Array, input: Uint8Array, seed: Uint8Array, maxOutput: number): Promise<WasmRun> {
  let inspected: Inspected;
  try {
    inspected = inspectWasm(programBytes); // again here: a miner checks for itself what it's asked to run
  } catch (err) {
    throw new JobError(`refused: ${err instanceof Error ? err.message : err}`);
  }
  const chunks: Uint8Array[] = [];
  let outputSize = 0;
  let memory: WebAssembly.Memory | null = null;
  const mem = () => new Uint8Array(memory!.buffer);
  const view = () => new DataView(memory!.buffer);
  const append = (bytes: Uint8Array) => {
    outputSize += bytes.length;
    if (outputSize > maxOutput) throw new JobError(`output over the limit of ${maxOutput} bytes`);
    chunks.push(bytes.slice());
  };
  const random = seeded(seed);
  let stdin = 0;

  const flyai = {
    input_len: () => input.length,
    input_read: (ptr: number) => { mem().set(input, ptr >>> 0); },
    output: (ptr: number, len: number) => { append(mem().subarray(ptr >>> 0, (ptr >>> 0) + (len >>> 0))); },
  };
  const wasi: Record<string, (...args: number[]) => number | void> = {
    fd_write: (fd, iovs, count, written) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      let total = 0;
      for (let i = 0; i < count; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        if (fd === 1) append(mem().subarray(ptr, ptr + len));
        total += len;
      }
      view().setUint32(written, total, true);
      return 0;
    },
    fd_read: (fd, iovs, count, read) => {
      if (fd !== 0) return EBADF;
      let total = 0;
      for (let i = 0; i < count && stdin < input.length; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        const part = input.subarray(stdin, stdin + len);
        mem().set(part, ptr);
        stdin += part.length;
        total += part.length;
      }
      view().setUint32(read, total, true);
      return 0;
    },
    fd_close: () => 0,
    fd_seek: () => ESPIPE,
    fd_fdstat_get: (fd, buf) => {
      if (fd > 2) return EBADF;
      new Uint8Array(memory!.buffer, buf, 24).fill(0);
      view().setUint8(buf, 2); // character device
      return 0;
    },
    fd_prestat_get: () => EBADF, // no preopened directories: no files at all
    fd_prestat_dir_name: () => EBADF,
    args_sizes_get: (argc, size) => { view().setUint32(argc, 0, true); view().setUint32(size, 0, true); return 0; },
    args_get: () => 0,
    environ_sizes_get: (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (_id, _precision, out) => { view().setBigUint64(out, 0n, true); return 0; },
    clock_res_get: (_id, out) => { view().setBigUint64(out, 1n, true); return 0; },
    random_get: (buf, len) => { mem().set(random(len), buf); return 0; },
    sched_yield: () => 0,
    proc_exit: (code) => { throw new Exit(code); },
  };

  let instance: WebAssembly.Instance;
  try {
    const module = await WebAssembly.compile(inspected.bytes as BufferSource);
    const imports: WebAssembly.Imports = { flyai: {}, wasi_snapshot_preview1: {} };
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === "flyai") (imports.flyai as Record<string, unknown>)[imp.name] = flyai[imp.name as keyof typeof flyai];
      else (imports.wasi_snapshot_preview1 as Record<string, unknown>)[imp.name] = wasi[imp.name] ?? (() => ENOSYS);
    }
    instance = await WebAssembly.instantiate(module, imports);
  } catch (err) {
    throw new JobError(`couldn't start the module: ${err instanceof Error ? err.message : err}`);
  }
  memory = instance.exports.memory as WebAssembly.Memory;
  try {
    (instance.exports[inspected.entry] as () => void)();
  } catch (err) {
    if (err instanceof Exit) {
      if (err.code !== 0) throw new JobError(`exited with code ${err.code}`);
    } else if (err instanceof JobError) {
      throw err;
    } else {
      // a trap: the message is the engine's, which differs between browsers, so only its kind is kept
      throw new JobError(err instanceof WebAssembly.RuntimeError ? "trap" : "crashed");
    }
  }
  const output = new Uint8Array(outputSize);
  let at = 0;
  for (const c of chunks) {
    output.set(c, at);
    at += c.length;
  }
  return { output };
}

export interface ShaderJob {
  code: string;
  input: Uint8Array;
  /** workgroups in x, y, z */
  dispatch: [number, number, number];
  outputBytes: number;
  index: number;
}

/**
 * Run a compute shader once. Bindings the shader declares (any it doesn't use are fine):
 *   @group(0) @binding(0) var<storage, read> input: array<u32>;        // the input, zero-padded to 4 bytes
 *   @group(0) @binding(1) var<storage, read_write> output: array<u32>; // outputBytes, starts zeroed
 *   @group(0) @binding(2) var<uniform> job: Job;                        // struct Job { index: u32, input_bytes: u32, output_bytes: u32, pad: u32 }
 * The entry point is `main`. Any element type works over those bytes (f32, i32, structs).
 */
export async function runShader(job: ShaderJob): Promise<Uint8Array> {
  const [x, y, z] = job.dispatch;
  if (x * y * z > MAX_DISPATCH) throw new JobError(`dispatch of ${x * y * z} workgroups is over the limit of ${MAX_DISPATCH}`);
  const gpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
  const adapter = await gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no GPU here"); // not the program's fault: not an answer
  const device = await adapter.requestDevice();
  try {
    let lost: string | null = null;
    device.lost.then((info) => { lost = info.message || "device lost"; });
    device.pushErrorScope("validation");
    device.pushErrorScope("out-of-memory");
    const module = device.createShaderModule({ code: job.code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) throw new JobError(`shader doesn't compile: ${errors[0].message.slice(0, 200)}`);

    const size4 = (n: number) => Math.max(4, Math.ceil(n / 4) * 4);
    const input = device.createBuffer({ size: size4(job.input.length), usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    new Uint8Array(input.getMappedRange()).set(job.input);
    input.unmap();
    const output = device.createBuffer({ size: size4(job.outputBytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    new Uint32Array(uniform.getMappedRange()).set([job.index, job.input.length, job.outputBytes, 0]);
    uniform.unmap();
    const read = device.createBuffer({ size: size4(job.outputBytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    let pipeline: GPUComputePipeline;
    try {
      pipeline = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: "main" } });
    } catch (err) {
      throw new JobError(`shader doesn't match the bindings: ${String((err as Error).message ?? err).slice(0, 200)}`);
    }
    const group = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }, { binding: 2, resource: { buffer: uniform } }],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
    enc.copyBufferToBuffer(output, 0, read, 0, read.size);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const oom = await device.popErrorScope();
    const invalid = await device.popErrorScope();
    if (oom) throw new JobError("out of GPU memory");
    if (invalid) throw new JobError(`invalid: ${invalid.message.slice(0, 200)}`);
    if (lost) throw new Error(lost);
    return new Uint8Array(read.getMappedRange().slice(0, job.outputBytes));
  } finally {
    device.destroy();
  }
}
