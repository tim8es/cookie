import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte({ preprocess: vitePreprocess() })],
  server: {
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
  },
});
