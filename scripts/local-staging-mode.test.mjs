import assert from "node:assert/strict";
import test from "node:test";
import { isLocalStagingProject, resolveLocalStagingMode, localDemoFetch } from "./local-staging-mode.mjs";

test("interactive demo uses the same disposable lifecycle as CI, but never the persistent profile", () => {
  const start = resolveLocalStagingMode([], undefined);
  const stop = resolveLocalStagingMode(["stop"], undefined);
  const demo = resolveLocalStagingMode(["demo"], undefined);
  const verify = resolveLocalStagingMode(["verify"], "true");
  const verifyDemo = resolveLocalStagingMode(["verify-demo"], "true");
  const worker = resolveLocalStagingMode(["serve-demo"], undefined, true, "120");
  assert.equal(start.disposable, false);
  assert.equal(stop.disposable, false);
  assert.equal(start.folderPrefix, stop.folderPrefix);
  assert.equal(start.projectPrefix, stop.projectPrefix);
  assert.equal(demo.demo, true);
  assert.equal(demo.verification, false);
  assert.equal(demo.disposable, true);
  assert.equal(verify.disposable, true);
  assert.equal(verify.verification, true);
  assert.equal(verifyDemo.demo, true);
  assert.equal(verifyDemo.verification, true);
  assert.equal(verifyDemo.disposable, demo.disposable);
  assert.equal(verifyDemo.folderPrefix, demo.folderPrefix);
  assert.equal(verifyDemo.projectPrefix, demo.projectPrefix);
  assert.equal(worker.worker, true);
  assert.equal(worker.demo, true);
  assert.equal(worker.disposable, true);
  assert.equal(worker.projectPrefix, demo.projectPrefix);
  assert.equal(worker.folderPrefix, demo.folderPrefix);
  assert.equal(worker.lifetimeMs, 120000);
  assert.equal(new Set([start.folderPrefix, demo.folderPrefix, verify.folderPrefix]).size, 3);
  assert.equal(new Set([start.projectPrefix, demo.projectPrefix, verify.projectPrefix]).size, 3);
  for (const mode of [start, demo, verify]) {
    for (const other of [start, demo, verify]) {
      assert.equal(isLocalStagingProject(mode, other.projectPrefix + "012345abcdef"), mode === other);
    }
    for (const invalid of [null, "production", mode.projectPrefix, mode.projectPrefix + "012345abcdef-extra"]) {
      assert.equal(isLocalStagingProject(mode, invalid), false);
    }
  }
});

test("invalid mode and non-CI verification fail closed", () => {
  for (const args of [["reset"], ["demo", "extra"], ["verify"], ["verify-demo"]]) {
    assert.throws(() => resolveLocalStagingMode(args, undefined));
  }
});

test("demo seed transport permits only the exact loopback API and rejects redirects", async () => {
  for (const invalid of ["https://127.0.0.1:1234", "http://localhost:1234", "http://127.0.0.1", "http://127.0.0.1:1234/path", "http://user@127.0.0.1:1234", "https://example.com"]) {
    assert.throws(() => localDemoFetch(invalid));
  }
  const calls = [];
  const fetcher = localDemoFetch("http://127.0.0.1:1234", async (...args) => { calls.push(args); return "ok"; });
  for (const invalid of ["https://example.com/v1/auth", "//example.com/v1/auth", "/v1/../other", "/v1/%2e%2e/other"]) {
    await assert.rejects(() => fetcher(invalid));
  }
  assert.equal(await fetcher("/v1/auth/telegram/exchange", { redirect: "follow", credentials: "include" }), "ok");
  assert.deepEqual(calls, [["http://127.0.0.1:1234/v1/auth/telegram/exchange", { redirect: "error", credentials: "omit" }]]);
});

test("private demo worker cannot be detached or left running indefinitely", () => {
  assert.throws(() => resolveLocalStagingMode(["serve-demo"], "true", false, "120"));
  for (const ttl of [undefined, "", "0", "-1", "01", "1.5", "901", "Infinity", " 4"]) {
    assert.throws(() => resolveLocalStagingMode(["serve-demo"], "true", true, ttl));
  }
  assert.equal(resolveLocalStagingMode(["serve-demo"], undefined, true, "900").lifetimeMs, 900000);
});
