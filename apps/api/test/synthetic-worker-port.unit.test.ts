import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { runSyntheticPostgresOutboxWorker } from "../../../packages/platform-db/src/index.js";

test("synthetic worker capability is inert when shutdown is already requested", async () => {
  const controller = new AbortController();
  controller.abort();
  const pool = {
    query() {
      assert.fail("a stopped worker must not query the database");
    },
    connect() {
      assert.fail("a stopped worker must not connect");
    },
  } as unknown as Pool;
  const observed: unknown[] = [];
  const totals = await runSyntheticPostgresOutboxWorker(pool, {
    signal: controller.signal,
    observe: (sample) => observed.push(sample),
  });
  assert.deepEqual(totals, { claimed: 0, delivered: 0, failed: 0, stale: 0 });
  assert.deepEqual(observed, [
    { kind: "stopped", totals, consecutivePollErrors: 0 },
  ]);
});
