import assert from "node:assert/strict";
import test from "node:test";

import { startChromiumWithRetry } from "./f1-chromium-startup.mjs";

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
