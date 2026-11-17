import assert from "node:assert/strict";
import test from "node:test";
import { isLocalStagingProject, resolveLocalStagingMode } from "./local-staging-mode.mjs";

test("interactive demo uses the same disposable lifecycle as CI, but never the persistent profile", () => {
  const start = resolveLocalStagingMode([], undefined);
  const stop = resolveLocalStagingMode(["stop"], undefined);
  const demo = resolveLocalStagingMode(["demo"], undefined);
  const verify = resolveLocalStagingMode(["verify"], "true");
  assert.equal(start.disposable, false);
  assert.equal(stop.disposable, false);
  assert.equal(start.folderPrefix, stop.folderPrefix);
  assert.equal(start.projectPrefix, stop.projectPrefix);
  assert.equal(demo.demo, true);
  assert.equal(demo.verification, false);
  assert.equal(demo.disposable, true);
  assert.equal(verify.disposable, true);
  assert.equal(verify.verification, true);
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
  for (const args of [["reset"], ["demo", "extra"], ["verify"]]) {
    assert.throws(() => resolveLocalStagingMode(args, undefined));
  }
});
