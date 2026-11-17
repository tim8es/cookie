import assert from "node:assert/strict";
import test from "node:test";
import { recoverPrivateDemoProject } from "./private-demo-recovery.mjs";

test("recovery denies foreign projects and live ports; targets only exact disposable project", async () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0 }; };
  const origin = "http://127.0.0.1:1234";
  const project = "cookie-demo-012345abcdef";
  const opts = { probe: async () => true, run };
  for (const name of ["cookie-manual-012345abcdef", "production", "cookie-demo-", project + "-extra"]) {
    assert.equal(await recoverPrivateDemoProject(name, origin, opts), false);
  }
  await assert.rejects(recoverPrivateDemoProject(project, "https://example.invalid", opts));
  assert.equal(await recoverPrivateDemoProject(project, origin, { ...opts, probe: async () => false }), false);
  assert.equal(calls.length, 0);
  assert.equal(await recoverPrivateDemoProject(project, origin, opts), true);
  const [command, args, options] = calls[0];
  assert.equal(command, "docker");
  assert.deepEqual(args.slice(0, 4), ["compose", "-p", project, "-f"]);
  assert.deepEqual(args.slice(-2), ["down", "-v"]);
  assert.equal(options.env.COOKIE_MANUAL_DB_PASSWORD, "disposable-recovery-only");
  assert.equal(await recoverPrivateDemoProject(project, origin, { ...opts, run: () => ({ status: 1 }) }), false);
});
