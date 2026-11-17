import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Fail the actual build if its executable dependency graph contains a
// legacy fixture controller or adapter, even if the route is unreachable.
function runtimeWithoutMock(): Plugin {
  return {
    name: "runtime-without-legacy-mock",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        for (const id of Object.keys(item.modules)) {
          const name = id.replaceAll("\\", "/").split("?")[0] ?? "";
          if (
            /\/src\/(?:LegacyFixture\.svelte|lib\/(?:mock|api)\.ts)$/.test(name)
          ) {
            this.error("Legacy fixture leaked into compiled runtime: " + name);
          }
        }
      }
      console.log(
        "PASS compiled runtime excludes the legacy mock controller and adapters",
      );
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    tailwindcss(),
    svelte({ preprocess: vitePreprocess({ script: true }) }),
    ...(mode === "ui-fixture" ? [] : [runtimeWithoutMock()]),
  ],
  resolve: {
    alias: { $lib: path.resolve(import.meta.dirname, "src/lib") },
  },
  server: {
    host: "127.0.0.1",
  },
  build: {
    // The server and image copy only dist. Fixture assets cannot share it.
    outDir: mode === "ui-fixture" ? ".tmp/ui-fixture-dist" : "dist",
    emptyOutDir: true,
  },
}));
