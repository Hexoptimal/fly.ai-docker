import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served at flyaiworld.com/flybook/ from the main Vercel project (see the root vercel.json).
// The language runtime and English strings are imported from docs/assets/i18n/, outside this folder.
export default defineConfig({ base: "/flybook/", plugins: [react()], server: { fs: { allow: ["../.."] } } });
