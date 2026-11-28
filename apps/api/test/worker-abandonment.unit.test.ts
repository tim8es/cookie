import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

const cases = [
  "shutdown-after-claim",
  "renewal-refused",
  "shutdown-after-renewal",
  "dispatch-authority-refused",
  "shutdown-before-handler",
  "dispatch-transaction-before-handler",
  "dispatch-transaction-after-handler",
  "handler-deadline",
] as const;

for (const reason of cases) {
  test(`bounded worker reports sanitized abandonment: ${reason}`, async () => {
    const shutdown = new AbortController();
    const commands: string[] = [];
    const releases: boolean[] = [];
    let queries = 0;
    let invoked = 0;
    let handlerAborted = false;
    const pool = {
      async query() {
        queries++;
        if (queries === 1) return { rows: [] };
        if (queries === 2) {
          if (reason === "shutdown-after-claim") shutdown.abort();
          return {
            rows: [
              {
                id: "private-event",
                tenant_id: "private-tenant",
                topic: "test.synthetic",
                payload: { synthetic: true },
                attempts: 1,
                lease_token: "private-token",
              },
            ],
          };
        }
        if (queries === 3) {
          if (reason === "shutdown-after-renewal") shutdown.abort();
          return { rowCount: reason === "renewal-refused" ? 0 : 1 };
        }
        assert.fail("worker must not ACK, fail or claim another event");
      },
      async connect() {
        return {
          async query(sql: string) {
            if (sql === "BEGIN") {
              commands.push(sql);
              if (reason === "dispatch-transaction-before-handler") {
                throw new Error("private database error");
              }
              return { command: "BEGIN" };
            }
            if (sql.startsWith("SET LOCAL")) return { command: "SET" };
            if (sql.includes("FOR UPDATE SKIP LOCKED")) {
              commands.push("authority");
              if (reason === "shutdown-before-handler") shutdown.abort();
              return {
                rowCount: reason === "dispatch-authority-refused" ? 0 : 1,
              };
            }
            commands.push(sql);
            if (sql === "COMMIT") {
              if (reason === "dispatch-transaction-after-handler") {
                throw new Error("private commit error");
              }
              return { command: "COMMIT" };
            }
            if (sql === "ROLLBACK") return { command: "ROLLBACK" };
            assert.fail("unexpected transaction statement");
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
        async (_lease, signal) => {
          invoked++;
          signal.addEventListener(
            "abort",
            () => {
              handlerAborted = true;
            },
            { once: true },
          );
          if (reason === "handler-deadline") {
            await new Promise<void>(() => undefined);
          }
        },
        {
          signal: shutdown.signal,
          topic: "test.synthetic",
          leaseMs: 10000,
          handlerTimeoutMs: 10,
        },
      ),
      {
        message: `Outbox supervisor stopped after abandoned lease (${reason})`,
      },
    );
    const afterHandler =
      reason === "dispatch-transaction-after-handler" ||
      reason === "handler-deadline";
    assert.equal(invoked, afterHandler ? 1 : 0);
    assert.equal(handlerAborted, afterHandler);
    assert.equal(queries, reason === "shutdown-after-claim" ? 2 : 3);
    if (
      reason === "dispatch-authority-refused" ||
      reason === "shutdown-before-handler"
    ) {
      assert.deepEqual(commands, ["BEGIN", "authority", "ROLLBACK"]);
      assert.deepEqual(releases, [false]);
    } else if (reason === "dispatch-transaction-before-handler") {
      assert.deepEqual(commands, ["BEGIN"]);
      assert.deepEqual(releases, [true]);
    } else if (afterHandler) {
      assert.deepEqual(commands, ["BEGIN", "authority", "COMMIT"]);
      assert.deepEqual(releases, [
        reason === "dispatch-transaction-after-handler",
      ]);
    } else {
      assert.deepEqual(commands, []);
      assert.deepEqual(releases, []);
    }
  });
}
