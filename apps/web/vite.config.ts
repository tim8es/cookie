import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [tailwindcss(), svelte({ preprocess: vitePreprocess({ script: true }) })],
  resolve: {
    alias: { $lib: path.resolve(import.meta.dirname, "src/lib") },
  },
  server: {
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
  },
});
