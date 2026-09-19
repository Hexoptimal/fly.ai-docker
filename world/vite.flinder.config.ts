import { defineConfig } from "vite";

// Flinder: its own page on the site at /flinder/, built from the same engine as the Simulation.
// No publicDir: the brain files are not copied again; the page loads them from /simulation/connectome/.
export default defineConfig({
  base: "/flinder/",
  publicDir: false,
  build: {
    target: "es2022",
    outDir: "dist-flinder",
    emptyOutDir: true,
    rollupOptions: { input: { index: "flinder.html" } },
  },
});
