import { defineConfig } from "vite";

// Fly Radio: its own page on the site at /radio/, built from the same engine as the Simulation.
// No publicDir: the brain files are not copied again; the page loads them from /simulation/connectome/.
export default defineConfig({
  base: "/radio/",
  publicDir: false,
  build: {
    target: "es2022",
    outDir: "dist-radio",
    emptyOutDir: true,
    rollupOptions: { input: { index: "radio.html" } },
  },
});
