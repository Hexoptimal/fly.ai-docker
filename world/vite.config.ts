import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { target: "es2022", outDir: "dist" },
  // `npx vite` for local work: Fly Roulette's bets and the site's shared files come from a local mining server
  // (cd mine && npm start, port 8787), as they come from the same site in production
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/compute": "http://localhost:8787",
      "/assets": "http://localhost:8787",
    },
  },
});
