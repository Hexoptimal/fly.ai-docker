#!/usr/bin/env node
/**
 * Bundles src/kit.ts (wagmi, viem, WalletConnect) into ES modules the compute pages import as
 * /compute/mine/web/wallet/kit.js. WalletConnect's modal is split into chunks that load only when it opens.
 *
 *   node build.mjs [out]   (default: dist/; mine/scripts/build-web.mjs passes <site>/mine/web/wallet)
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? join(HERE, "dist"));
rmSync(OUT, { recursive: true, force: true });
await build({
  entryPoints: { kit: join(HERE, "src/kit.ts") },
  outdir: OUT,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  chunkNames: "chunks/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "warning",
});
console.log(`wallet kit built to ${OUT}`);
