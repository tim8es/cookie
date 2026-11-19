import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

test("dispatch BEGIN failure discards client and stops before invoking handler", async () => {
  let queries = 0;
  let invoked = 0;
  const releases: boolean[] = [];
  const sql: string[] = [];
  const pool = {
    async query() {
      queries++;
      if (queries === 1) return { rows: [] };
      if (queries === 2) {
        return {
          rows: [
            {
              id: "synthetic-event",
              tenant_id: "synthetic-tenant",
              topic: "test.synthetic",
              payload: { synthetic: true },
              attempts: 1,
              lease_token: "synthetic-token",
            },
          ],
        };
      }
      if (queries === 3) return { rowCount: 1 };
      assert.fail("worker must not ACK, fail or claim another event");
    },
    async connect() {
      return {
        async query(statement: string) {
          sql.push(statement);
          throw new Error("SYNTHETIC_BEGIN_ACK_LOST");
        },
        release(discard: boolean) {
          releases.push(discard);
        },
      };
    },
  } as unknown as Pool;
  await assert.rejects(
    runTrustedPostgresOutboxWorker(
      pool,
      async () => {
        invoked++;
      },
      {
        signal: new AbortController().signal,
        topic: "test.synthetic",
        leaseMs: 10000,
        handlerTimeoutMs: 1000,
      },
    ),
    /Outbox supervisor stopped after abandoned lease/,
  );
  assert.equal(invoked, 0);
  assert.equal(queries, 3);
  assert.deepEqual(sql, ["BEGIN"]);
  assert.deepEqual(releases, [true]);
});
