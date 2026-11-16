import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

const fakePool = {} as Pool;

test("bounded Outbox worker validates deadline before DB access", () => {
  const controller = new AbortController();
  for (const timeout of [0, -1, 30_000, 29_900, 600_000, 10.5]) {
    assert.throws(
      () =>
        runTrustedPostgresOutboxWorker(fakePool, async () => {}, {
          signal: controller.signal,
          leaseMs: 30_000,
          handlerTimeoutMs: timeout,
        }),
      /Invalid outbox handler timeout/,
    );
  }
});

test("unbounded legacy API stays compatible and aborted worker does not claim", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await runTrustedPostgresOutboxWorker(fakePool, async () => {}, {
      signal: controller.signal,
      leaseMs: 1,
    }),
    { claimed: 0, delivered: 0, failed: 0, stale: 0 },
  );
});
