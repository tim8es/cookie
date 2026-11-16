import { realpath, symlink } from "node:fs/promises";
import { resolve } from "node:path";

// Compiled TS lives under dist/apps/api; pnpm installs Fastify in apps/api.
// Keep ESM resolution correct without a runtime package manager or npm install.
const link = resolve("dist/apps/api/node_modules");
const expected = resolve("apps/api/node_modules");
try {
  await symlink("../../../apps/api/node_modules", link, "dir");
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
}
const actual = await realpath(link);
if (actual !== expected) {
  throw new Error("Compiled app dependency link points outside the expected workspace");
}
