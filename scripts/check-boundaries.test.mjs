import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkFileImports, checkRepository } from "./check-boundaries.mjs";

const root = join(process.cwd(), "test-module-root");
const file = join(root, "packages/domain-booking/src/create.ts");
const report = (content, exceptions = []) =>
  checkFileImports({ root, file, content, exceptions: new Set(exceptions) });

test("allows local imports and published contracts without grandfathering", () => {
  const result = report("import './local.js'; import type { Foo } from '@cookie/contracts';");
  assert.deepEqual(result.failures, []);
});

test("rejects new deep imports of another domain and platform implementation", () => {
  const result = report("import '../../platform-db/src/worker.js'; import '../../domain-scheduling/src/index.js';");
  assert.equal(result.failures.length, 2);
});

test("grandfathers only the exact existing import in the exact file", () => {
  const legacy = "packages/domain-booking/src/create.ts|../../platform-db/src/outbox.js";
  assert.deepEqual(report("import '../../platform-db/src/outbox.js';", [legacy]).failures, []);
  assert.equal(report("import '../../platform-db/src/worker.js';", [legacy]).failures.length, 1);
  const other = join(root, "packages/domain-booking/src/other.ts");
  const result = checkFileImports({
    root,
    file: other,
    content: "import '../../platform-db/src/outbox.js';",
    exceptions: new Set([legacy]),
  });
  assert.equal(result.failures.length, 1);
});

test("protects kernel and contracts from high-level dependencies", () => {
  const kernel = join(root, "packages/kernel/src/index.ts");
  const result = checkFileImports({
    root,
    file: kernel,
    content: "export * from '../../domain-booking/src/create.js'; import('@cookie/platform-db');",
  });
  assert.equal(result.failures.length, 2);
});

test("rejects cross-module imports through import type, dynamic import and require", () => {
  const source =
    "type T = import('../../platform-identity/src/authorization.js').TrustedActor; " +
    "const f = import('../../platform-db/src/outbox.js'); " +
    "const x = require('../../platform-db/src/worker.js');";
  assert.equal(report(source).failures.length, 3);
});

test("prevents production imports of sibling test folders or app source", () => {
  const result = report("import '../test/mocked-db.js'; import '../../../../apps/api/src/app.js';");
  assert.equal(result.failures.length, 2);
});

test("cannot bypass boundary policy through package aliases", () => {
  const result = report("import '@cookie/platform-db'; import '@cookie/contracts/src/index.js';");
  assert.equal(result.failures.length, 2);
});

test("repository scan rejects new cross-module imports and stale exceptions", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "cookie-boundaries-"));
  try {
    const domain = join(sandbox, "packages/domain-booking/src");
    const platform = join(sandbox, "packages/platform-db/src");
    await Promise.all([
      mkdir(domain, { recursive: true }),
      mkdir(platform, { recursive: true }),
      mkdir(join(sandbox, "scripts"), { recursive: true }),
    ]);
    const path = join(domain, "create.ts");
    const importText = "../../platform-db/src/outbox.js";
    await writeFile(path, "import '" + importText + "';");
    await writeFile(join(platform, "outbox.ts"), "export const value = 1;");
    const baseline = join(sandbox, "scripts/module-boundaries-legacy.json");
    await writeFile(baseline, JSON.stringify({ "packages/domain-booking/src/create.ts": [importText] }));
    assert.deepEqual((await checkRepository(sandbox)).failures, []);
    await writeFile(path, "import '../../platform-db/src/worker.js';");
    const broken = (await checkRepository(sandbox)).failures;
    assert.ok(broken.some((line) => line.includes("cross-module")));
    assert.ok(broken.some((line) => line.includes("Stale legacy exception")));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
