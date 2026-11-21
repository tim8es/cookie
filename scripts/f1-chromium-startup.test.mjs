import assert from "node:assert/strict";
import test from "node:test";

import { probeChromiumPage, startChromiumWithRetry } from "./f1-chromium-startup.mjs";

const running = () => ({ exitCode: null, signalCode: null });

test("an early Chromium exit is reaped before the only startup retry", async () => {
  const launched = [];
  const disposed = [];
  const outcome = await startChromiumWithRetry({
    startupTimeoutMs: 100,
    intervalMs: 1,
    startAttempt: async (index) => {
      const handle = {
        index,
        chrome: index === 1 ? { exitCode: 1, signalCode: null } : running(),
        logs: ["synthetic browser diagnostics"],
      };
      launched.push(index);
      return handle;
    },
    probe: async (handle) =>
      handle.index === 2 ? { webSocketDebuggerUrl: "ws://127.0.0.1/test" } : null,
    disposeAttempt: async (handle) => disposed.push(handle.index),
  });

  assert.equal(outcome.attempt, 2);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.startup.attempt, 2);
  assert.ok(Number.isInteger(outcome.startup.elapsedMs) && outcome.startup.elapsedMs >= 0);
  assert.equal(outcome.startup.stage, "not-probed");
  assert.equal(outcome.startup.probes, 0);
  assert.equal(outcome.startup.pid, null);
  assert.match(outcome.failures[0], /exit=1/);
  assert.deepEqual(launched, [1, 2]);
  assert.deepEqual(disposed, [1]);
  assert.equal(outcome.ready.webSocketDebuggerUrl, "ws://127.0.0.1/test");
});

test("successful initial CDP startup does not retry or destroy the live browser", async () => {
  let launched = 0;
  let disposed = 0;
  const outcome = await startChromiumWithRetry({
    startupTimeoutMs: 100,
    intervalMs: 1,
    startAttempt: async () => {
      launched++;
      return { chrome: running() };
    },
    probe: async () => ({ ready: true }),
    disposeAttempt: async () => {
      disposed++;
    },
  });

  assert.equal(outcome.attempt, 1);
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.startup.attempt, 1);
  assert.equal(outcome.startup.executable, "unknown");
  assert.ok(Number.isInteger(outcome.startup.elapsedMs) && outcome.startup.elapsedMs >= 0);
  assert.equal(launched, 1);
  assert.equal(disposed, 0);
});

test("two failed probes abort with bounded diagnostics and clean each profile", async () => {
  const disposed = [];
  await assert.rejects(
    startChromiumWithRetry({
      startupTimeoutMs: 3,
      intervalMs: 1,
      startAttempt: async (index) => ({
        index,
        chrome: running(),
        logs: ["only synthetic stderr"],
      }),
      probe: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1");
      },
      disposeAttempt: async (handle) => disposed.push(handle.index),
    }),
    (error) => {
      assert.match(error.message, /startup attempt 1\/2/);
      assert.match(error.message, /startup attempt 2\/2/);
      assert.match(error.message, /ECONNREFUSED/);
      assert.match(error.message, /only synthetic stderr/);
      assert.match(error.message, /elapsedMs=\d+/);
      assert.match(error.message, /pid=unavailable/);
      return true;
    },
  );
  assert.deepEqual(disposed, [1, 2]);
});

test("cleanup failure is fatal and cannot spawn a second browser", async () => {
  let launched = 0;
  await assert.rejects(
    startChromiumWithRetry({
      startAttempt: async () => {
        launched++;
        return { chrome: { exitCode: 2, signalCode: null } };
      },
      probe: async () => null,
      disposeAttempt: async () => {
        throw new Error("profile cannot be removed");
      },
    }),
    /cleanup FAILED: profile cannot be removed/,
  );
  assert.equal(launched, 1);
});

test("invalid or unbounded retries fail before spawning", async () => {
  let launched = 0;
  await assert.rejects(
    startChromiumWithRetry({
      attempts: 3,
      startAttempt: async () => {
        launched++;
        return { chrome: running() };
      },
      probe: async () => null,
      disposeAttempt: async () => undefined,
    }),
    /Invalid bounded Chromium startup retry configuration/,
  );
  assert.equal(launched, 0);
});

test("successful CDP readiness reports only bounded child metadata, never target payload", async () => {
  const outcome = await startChromiumWithRetry({
    attempts: 1,
    startupTimeoutMs: 1000,
    intervalMs: 1,
    startAttempt: async () => ({
      chrome: { ...running(), pid: 4321 },
      executable: "chromium",
      probeStage: "port-file",
      probeCount: 1,
    }),
    probe: async (handle) => {
      handle.probeStage = "page-target";
      handle.probeCount++;
      return { webSocketDebuggerUrl: "ws://127.0.0.1/synthetic-secret" };
    },
    disposeAttempt: async () => {
      throw new Error("must not dispose ready browser");
    },
  });
  assert.deepEqual(outcome.startup, {
    attempt: 1,
    elapsedMs: outcome.startup.elapsedMs,
    executable: "chromium",
    stage: "page-target",
    probes: 2,
    pid: 4321,
  });
  assert.ok(outcome.startup.elapsedMs >= 0);
  assert.ok(!JSON.stringify(outcome.startup).includes("synthetic-secret"));
});

test("a page returned after child exit cannot be accepted as readiness", async () => {
  const disposed = [];
  const outcome = await startChromiumWithRetry({
    startupTimeoutMs: 1000,
    intervalMs: 1,
    startAttempt: async (index) => ({ index, chrome: running() }),
    probe: async (handle) => {
      if (handle.index === 1) handle.chrome.exitCode = 7;
      return { ready: true };
    },
    disposeAttempt: async (handle) => disposed.push(handle.index),
  });
  assert.equal(outcome.attempt, 2);
  assert.deepEqual(disposed, [1]);
  assert.match(outcome.failures[0], /exit=7/);
});

test("a late page result does not extend the startup deadline", async () => {
  const disposed = [];
  await assert.rejects(startChromiumWithRetry({
    attempts: 1,
    startupTimeoutMs: 5,
    intervalMs: 1,
    startAttempt: async () => ({ chrome: running() }),
    probe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ready: true };
    },
    disposeAttempt: async () => disposed.push(1),
  }), /CDP readiness timed out/);
  assert.deepEqual(disposed, [1]);
});

test("CDP discovery distinguishes port, transport, response and page readiness", async () => {
  const handle = { dir: "synthetic-profile", executable: "chromium" };
  let contents = null;
  let result = { code: 503, body: "" };
  let failTransport = false;
  const dependencies = {
    readPort: () => contents,
    getLocal: async (url) => {
      assert.equal(url, "http://127.0.0.1:43210/json/list");
      if (failTransport) throw new Error("synthetic timeout");
      return result;
    },
  };
  assert.equal(await probeChromiumPage(handle, dependencies), null);
  assert.equal(handle.probeStage, "port-file");
  contents = "not-a-port";
  assert.equal(await probeChromiumPage(handle, dependencies), null);
  assert.equal(handle.probeStage, "invalid-port");
  contents = "43210\n/devtools/browser/test";
  failTransport = true;
  await assert.rejects(probeChromiumPage(handle, dependencies), /synthetic timeout/);
  assert.equal(handle.probeStage, "http-transport");
  failTransport = false;
  assert.equal(await probeChromiumPage(handle, dependencies), null);
  assert.equal(handle.probeStage, "http-status-503");
  result = { code: 200, body: "{" };
  await assert.rejects(probeChromiumPage(handle, dependencies), SyntaxError);
  assert.equal(handle.probeStage, "invalid-target-list");
  result = { code: 200, body: "[]" };
  assert.equal(await probeChromiumPage(handle, dependencies), null);
  assert.equal(handle.probeStage, "no-page-target");
  const page = { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/test" };
  result = { code: 200, body: JSON.stringify([page]) };
  assert.deepEqual(await probeChromiumPage(handle, dependencies), page);
  assert.equal(handle.probeStage, "page-target");
  assert.equal(handle.probeCount, 7);
});
