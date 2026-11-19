import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite";

// Separate local review entry, never included in the production dist.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss(), svelte({ preprocess: vitePreprocess({ script: true }) })],
  resolve: {
    alias: { $lib: path.resolve(import.meta.dirname, "src/lib") },
  },
  server: {
    host: "127.0.0.1",
  },
  build: {
    outDir: ".tmp/rhythm-ui-kit-dist",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, "ui-kit/index.html"),
    },
  },
});
