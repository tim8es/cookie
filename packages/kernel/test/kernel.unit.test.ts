import assert from "node:assert/strict";
import test from "node:test";

import {
  createKernel,
  KernelError,
  type CookieModule,
  type ModuleManifest,
} from "../src/index.js";

function moduleWith(
  manifest: ModuleManifest,
  hooks: Partial<Pick<CookieModule, "register" | "start" | "stop">> = {},
): CookieModule {
  return {
    manifest,
    register: hooks.register ?? (() => {}),
    start: hooks.start,
    stop: hooks.stop,
  };
}

test("providers start first, capabilities resolve only for declared consumers, stop reverses order", async () => {
  const calls: string[] = [];
  const service = { execute: () => "ok" };
  const provider = moduleWith(
    { id: "provider", version: "1.0.0", provides: [{ name: "work.run", version: "1.2.3" }] },
    {
      register: (context) => context.provide("work.run", service),
      start: () => { calls.push("provider:start"); },
      stop: () => { calls.push("provider:stop"); },
    },
  );
  const consumer = moduleWith(
    { id: "consumer", version: "1.0.0", requires: [{ name: "work.run", range: "^1.2.0" }] },
    {
      start: (context) => {
        calls.push("consumer:start");
        assert.strictEqual(context.resolve<typeof service>("work.run"), service);
        assert.equal(context.resolve<typeof service>("work.run").execute(), "ok");
        assert.throws(
          () => context.resolve("unlisted.port"),
          { code: "UNDECLARED_REQUIREMENT" },
        );
      },
      stop: () => { calls.push("consumer:stop"); },
    },
  );
  const kernel = createKernel([consumer, provider]);
  await kernel.start();
  assert.deepEqual(kernel.snapshot(), [
    { id: "consumer", version: "1.0.0", status: "running" },
    { id: "provider", version: "1.0.0", status: "running" },
  ]);
  await kernel.stop();
  assert.deepEqual(calls, [
    "provider:start",
    "consumer:start",
    "consumer:stop",
    "provider:stop",
  ]);
  await kernel.stop(); // idempotent stop
  assert.equal(kernel.snapshot()[0]?.status, "stopped");
  assert.equal(kernel.snapshot()[1]?.status, "stopped");
});

test("detects duplicate IDs, capability names, and required capabilities", () => {
  const root = moduleWith({ id: "root", version: "1.0.0" });
  assert.throws(() => createKernel([root, root]), { code: "DUPLICATE_MODULE" });
  const a = moduleWith({
    id: "a",
    version: "1.0.0",
    provides: [{ name: "p.cache", version: "1.0.0" }],
  });
  const b = moduleWith({
    id: "b",
    version: "1.0.0",
    provides: [{ name: "p.cache", version: "2.0.0" }],
  });
  assert.throws(() => createKernel([a, b]), { code: "DUPLICATE_PROVIDER" });
  const consumer = moduleWith({
    id: "consumer",
    version: "1.0.0",
    requires: [{ name: "missing.cap", range: "*" }],
  });
  assert.throws(() => createKernel([consumer]), { code: "MISSING_PROVIDER" });
});

test("enforces capability versions and rejects unsupported manifests", () => {
  const provider = moduleWith({
    id: "provider",
    version: "1.0.0",
    provides: [{ name: "ledger.check", version: "2.0.0" }],
  });
  const incompatible = moduleWith({
    id: "consumer",
    version: "1.0.0",
    requires: [{ name: "ledger.check", range: "^1.5.0" }],
  });
  assert.throws(() => createKernel([provider, incompatible]), {
    code: "INCOMPATIBLE_CAPABILITY",
  });
  assert.throws(
    () => createKernel([moduleWith({ id: "invalid!", version: "1.0.0" })]),
    { code: "INVALID_MANIFEST" },
  );
  assert.throws(
    () => createKernel([moduleWith({ id: "valid", version: "1.0.0-beta" })]),
    { code: "INVALID_MANIFEST" },
  );
  assert.throws(
    () => createKernel([
      moduleWith({
        id: "other",
        version: "1.0.0",
        requires: [{ name: "ledger.check", range: ">=1.0.0" }],
      }),
    ]),
    { code: "INVALID_MANIFEST" },
  );
  const compatible = moduleWith({
    id: "consumer",
    version: "1.0.0",
    requires: [{ name: "ledger.check", range: "~2.0.0" }],
  });
  assert.doesNotThrow(() => createKernel([provider, compatible]));
});

test("detects a self-cycle and a multi-module dependency cycle", () => {
  const a = moduleWith({
    id: "a",
    version: "1.0.0",
    provides: [{ name: "a.port", version: "1.0.0" }],
    requires: [{ name: "b.port", range: "*" }],
  });
  const b = moduleWith({
    id: "b",
    version: "1.0.0",
    provides: [{ name: "b.port", version: "1.0.0" }],
    requires: [{ name: "a.port", range: "*" }],
  });
  assert.throws(() => createKernel([a, b]), { code: "DEPENDENCY_CYCLE" });
  const self = moduleWith({
    id: "self",
    version: "1.0.0",
    provides: [{ name: "self.port", version: "1.0.0" }],
    requires: [{ name: "self.port", range: "*" }],
  });
  assert.throws(() => createKernel([self]), { code: "DEPENDENCY_CYCLE" });
});

test("optional module can be disabled without affecting required host", async () => {
  const host = moduleWith({ id: "host", version: "1.0.0" });
  const optional = moduleWith(
    { id: "extension", version: "1.0.0", optional: true },
    { register: () => { throw new Error("should not register"); } },
  );
  const kernel = createKernel([host, optional], {
    disabledModuleIds: ["extension"],
  });
  await kernel.start();
  assert.deepEqual(kernel.snapshot().map((item) => [item.id, item.status]), [
    ["extension", "disabled"],
    ["host", "running"],
  ]);
  await kernel.stop();
  assert.throws(
    () => createKernel([host], { disabledModuleIds: ["host"] }),
    { code: "REQUIRED_MODULE" },
  );
  assert.throws(
    () => createKernel([host], { disabledModuleIds: ["absent"] }),
    { code: "UNKNOWN_MODULE" },
  );
});

test("failure of optional extension is isolated, but consumers cannot use its failed capability", async () => {
  const host = moduleWith({ id: "host", version: "1.0.0" });
  const optional = moduleWith(
    {
      id: "extension",
      version: "1.0.0",
      optional: true,
      provides: [{ name: "extension.port", version: "1.0.0" }],
    },
    {
      register: (context) => context.provide("extension.port", { test: true }),
      start: () => { throw new Error("offline"); },
    },
  );
  const kernel = createKernel([host, optional]);
  await kernel.start();
  assert.equal(kernel.snapshot().find((m) => m.id === "extension")?.status, "failed");
  assert.equal(kernel.snapshot().find((m) => m.id === "host")?.status, "running");
  await kernel.stop();

  const consumer = moduleWith({
    id: "consumer",
    version: "1.0.0",
    requires: [{ name: "extension.port", range: "^1.0.0" }],
  });
  const dependentKernel = createKernel([host, optional, consumer]);
  await assert.rejects(() => dependentKernel.start(), {
    code: "UNAVAILABLE_PROVIDER",
  });
  assert.equal(dependentKernel.snapshot().find((m) => m.id === "host")?.status, "stopped");
});

test("required module startup failure stops previously started modules", async () => {
  const calls: string[] = [];
  const provider = moduleWith(
    { id: "provider", version: "1.0.0", provides: [{ name: "p.test", version: "1.0.0" }] },
    {
      register: (context) => context.provide("p.test", { ok: true }),
      start: () => { calls.push("start"); },
      stop: () => { calls.push("stop"); },
    },
  );
  const consumer = moduleWith(
    {
      id: "consumer",
      version: "1.0.0",
      requires: [{ name: "p.test", range: "*" }],
    },
    { start: () => { throw new KernelError("START_FAILURE", "synthetic"); } },
  );
  const kernel = createKernel([consumer, provider]);
  await assert.rejects(() => kernel.start(), { code: "START_FAILURE" });
  assert.deepEqual(calls, ["start", "stop"]);
  assert.equal(kernel.snapshot().find((m) => m.id === "consumer")?.status, "failed");
  assert.equal(kernel.snapshot().find((m) => m.id === "provider")?.status, "stopped");
  await assert.rejects(() => kernel.start(), { code: "INVALID_LIFECYCLE" });
});

test("rejects undeclared implementations and missing implementations", async () => {
  const undeclared = moduleWith(
    { id: "bad", version: "1.0.0" },
    { register: (context) => context.provide("unexpected", {}) },
  );
  await assert.rejects(() => createKernel([undeclared]).start(), {
    code: "UNDECLARED_PROVIDER",
  });
  const missing = moduleWith({
    id: "missing",
    version: "1.0.0",
    provides: [{ name: "missing.port", version: "1.0.0" }],
  });
  await assert.rejects(() => createKernel([missing]).start(), {
    code: "MISSING_IMPLEMENTATION",
  });
});

test("stops all started modules even when one stop throws", async () => {
  const calls: string[] = [];
  const a = moduleWith(
    { id: "a", version: "1.0.0" },
    { stop: () => { calls.push("a"); } },
  );
  const b = moduleWith(
    { id: "b", version: "1.0.0" },
    { stop: () => { calls.push("b"); throw new Error("stop failed"); } },
  );
  const kernel = createKernel([a, b]);
  await kernel.start();
  await assert.rejects(() => kernel.stop(), AggregateError);
  assert.deepEqual(calls, ["b", "a"]);
  assert.equal(kernel.snapshot().find((m) => m.id === "a")?.status, "stopped");
  assert.equal(kernel.snapshot().find((m) => m.id === "b")?.status, "failed");
});
