import { defineConfig } from "vite";

// Fly Roulette: its own page on the site at /roulette/, built from the same engine as the Simulation.
// No publicDir: the brain files are not copied again; the page loads them from /simulation/connectome/.
export default defineConfig({
  base: "/roulette/",
  publicDir: false,
  // the site's strings live in docs/assets/i18n/, outside this folder
  server: { fs: { allow: [".."] } },
  build: {
    target: "es2022",
    outDir: "dist-roulette",
    emptyOutDir: true,
    rollupOptions: { input: { index: "roulette.html" } },
  },
});
