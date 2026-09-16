// Matrix multiply on the GPU: the input is two n x n f32 matrices, A then B (8 * n * n bytes); the output is A * B.
// Order it with dispatch [ceil(n / 16), ceil(n / 16), 1], output_bytes 4 * n * n and compare {"f32_tolerance": ...}:
// GPUs from different vendors round floats slightly differently, so exact comparison would rarely agree.
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
struct Job { index: u32, input_bytes: u32, output_bytes: u32, pad: u32 }
@group(0) @binding(2) var<uniform> job: Job;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = u32(round(sqrt(f32(job.input_bytes / 8u))));
  let row = id.y;
  let col = id.x;
  if (row >= n || col >= n) { return; }
  var sum = 0.0;
  for (var k = 0u; k < n; k++) {
    sum += input[row * n + k] * input[n * n + k * n + col];
  }
  output[row * n + col] = sum;
}
