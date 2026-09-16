/**
 * Join mandelbrot_tiles.wasm outputs into one 2048 x 2048 grayscale image (PGM, which most viewers open).
 *
 *   node examples/order.ts create --program examples/mandelbrot-tiles/mandelbrot_tiles.wasm --count 64 --wallet 0x...
 *   node examples/order.ts watch --order ID --out tiles/
 *   node examples/mandelbrot-tiles/stitch.ts tiles/ mandelbrot.pgm
 *
 * Tile files are named by job number (000000.out .. 000063.out), which is the tile number.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GRID = 8;
export const TILE = 256;

export function stitch(tile: (n: number) => Uint8Array | null): Buffer {
  const size = GRID * TILE;
  const image = Buffer.alloc(size * size);
  for (let n = 0; n < GRID * GRID; n++) {
    const bytes = tile(n);
    if (!bytes) continue; // missing tiles stay black
    const counts = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const [tx, ty] = [n % GRID, Math.floor(n / GRID)];
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = counts[y * TILE + x];
        // inside the set is black; outside, brighter the sooner it escapes (log scale)
        image[(ty * TILE + y) * size + tx * TILE + x] = i === 0 ? 0 : 255 - Math.min(250, Math.round(Math.log2(i) * 23));
      }
    }
  }
  return Buffer.concat([Buffer.from(`P5\n${size} ${size}\n255\n`), image]);
}

if (process.argv[1]?.endsWith("stitch.ts")) {
  const [dir = "tiles", out = "mandelbrot.pgm"] = process.argv.slice(2);
  let found = 0;
  const pgm = stitch((n) => {
    const file = join(dir, `${String(n).padStart(6, "0")}.out`);
    if (!existsSync(file)) return null;
    found++;
    return new Uint8Array(readFileSync(file));
  });
  writeFileSync(out, pgm);
  console.log(`${found}/${GRID * GRID} tiles → ${out}`);
}
