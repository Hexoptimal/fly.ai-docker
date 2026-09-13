import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served at flyaiworld.com/flybook/ from the main Vercel project (see the root vercel.json).
export default defineConfig({ base: "/flybook/", plugins: [react()] });
