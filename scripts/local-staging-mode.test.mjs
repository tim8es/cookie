import assert from "node:assert/strict";
import test from "node:test";
import { isLocalStagingProject, resolveLocalStagingMode, localDemoFetch, localBookingCutoffs } from "./local-staging-mode.mjs";

test("interactive demo uses the same disposable lifecycle as CI, but never the persistent profile", () => {
  const start = resolveLocalStagingMode([], undefined);
  const stop = resolveLocalStagingMode(["stop"], undefined);
  const demo = resolveLocalStagingMode(["demo"], undefined);
  const verify = resolveLocalStagingMode(["verify"], "true");
  const verifyDemo = resolveLocalStagingMode(["verify-demo"], "true");
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

test("local booking cutoffs are separately explicit, validated and never inherited", () => {
  const calls = [];
  const parsers = Object.fromEntries(["customerCancel", "customerMove", "ownerCancel", "ownerMove"].map(key => [
    key, raw => {
      calls.push([key, raw]);
      if (raw === undefined) return undefined;
      if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("invalid cutoff");
      return Number(raw);
    },
  ]));
  const empty = localBookingCutoffs({
    COOKIE_STAGING_CUSTOMER_CANCEL_CUTOFF_MINUTES: "60",
    COOKIE_STAGING_CUSTOMER_RESCHEDULE_CUTOFF_MINUTES: "60",
    COOKIE_STAGING_OWNER_CANCEL_CUTOFF_MINUTES: "60",
    COOKIE_STAGING_OWNER_RESCHEDULE_CUTOFF_MINUTES: "60",
  }, parsers);
  assert.deepEqual(empty.runtimeEnv, {});
  assert.deepEqual(empty.values, { customerCancel: undefined, customerMove: undefined, ownerCancel: undefined, ownerMove: undefined });
  const inputs = [
    ["COOKIE_MANUAL_CANCEL_CUTOFF_MINUTES", "COOKIE_STAGING_CUSTOMER_CANCEL_CUTOFF_MINUTES", "customerCancel"],
    ["COOKIE_MANUAL_RESCHEDULE_CUTOFF_MINUTES", "COOKIE_STAGING_CUSTOMER_RESCHEDULE_CUTOFF_MINUTES", "customerMove"],
    ["COOKIE_MANUAL_OWNER_CANCEL_CUTOFF_MINUTES", "COOKIE_STAGING_OWNER_CANCEL_CUTOFF_MINUTES", "ownerCancel"],
    ["COOKIE_MANUAL_OWNER_RESCHEDULE_CUTOFF_MINUTES", "COOKIE_STAGING_OWNER_RESCHEDULE_CUTOFF_MINUTES", "ownerMove"],
  ];
  for (const [input, output, selected] of inputs) {
    calls.length = 0;
    const actual = localBookingCutoffs({ [input]: "0" }, parsers);
    assert.deepEqual(actual.runtimeEnv, { [output]: "0" });
    assert.equal(actual.values[selected], 0);
    assert.deepEqual(calls, inputs.map(([, , key]) => [key, key === selected ? "0" : undefined]));
    assert.throws(() => localBookingCutoffs({ [input]: "invalid" }, parsers), /invalid cutoff/);
  }
  const all = localBookingCutoffs(Object.fromEntries(inputs.map(([input], i) => [input, String(i + 1)])), parsers);
  assert.deepEqual(all.runtimeEnv, Object.fromEntries(inputs.map(([, output], i) => [output, String(i + 1)])));
});
