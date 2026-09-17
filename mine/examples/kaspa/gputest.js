// Runs khh.wgsl on this machine's GPU over a nonce range and reports the hits, so the test can compare them with
// the TypeScript implementation. Served with the shader and the job bytes next to it.
const out = document.getElementById("out");
const log = (s) => { out.textContent += s + "\n"; };
try {
  const [code, jobBytes] = await Promise.all([
    fetch("./khh.wgsl").then((r) => r.text()),
    fetch("./job.bin").then((r) => r.arrayBuffer()),
  ]);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const device = await adapter.requestDevice();
  device.addEventListener("uncapturederror", (e) => log(`gpu error: ${e.error.message}`));
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  for (const m of info.messages) log(`${m.type}: line ${m.lineNum}: ${m.message}`);
  if (info.messages.some((m) => m.type === "error")) throw new Error("the shader did not compile");
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
  const params = new URLSearchParams(location.search);
  const groups = Number(params.get("groups") ?? 1);
  const outputBytes = 4 + 16 * 40;
  const input = device.createBuffer({ size: jobBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(input, 0, jobBytes);
  const output = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniform, 0, new Uint32Array([0, jobBytes.byteLength, outputBytes, 0]));
  const readback = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }, { binding: 2, resource: { buffer: uniform } }] });
  const enc = device.createCommandEncoder();
  enc.clearBuffer(output);
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(groups);
  pass.end();
  enc.copyBufferToBuffer(output, 0, readback, 0, outputBytes);
  const t = performance.now();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t;
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  log(`adapter: ${adapter.info?.vendor ?? "?"} ${adapter.info?.architecture ?? ""}`);
  log(`ms ${ms.toFixed(1)}`);
  log(`RESULT ${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
} catch (err) {
  log(`RESULT error ${err?.message ?? err}`);
}
