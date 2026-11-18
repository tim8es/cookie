import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { idempotentProviderHandler } from "../../../packages/platform-db/src/delivery-port.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { enqueueOutbox } from "../../../packages/platform-db/src/outbox.js";
import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

test(
  "unacknowledged worker dispatch COMMIT halts without ACK or another claim",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-dispatch-commit",
      max: 4,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1::uuid,$2::uuid,'Synthetic dispatch commit')`,
        [tenant, owner],
      );

      for (const mode of ["abort", "lose-ack"] as const) {
        const topic =
          mode === "abort" ? "qa.dispatchcommit.abort" : "qa.dispatchcommit.lost";
        const writer = await pool.connect();
        let first: string;
        let second: string;
        try {
          const add = async () =>
            (
              await enqueueOutbox(writer, {
                tenantId: tenant,
                dedupeKey: randomUUID(),
                topic,
                payload: { synthetic: true },
                maxAttempts: 3,
              })
            ).id;
          first = await add();
          second = await add();
        } finally {
          writer.release();
        }
        await pool.query(
          `UPDATE cookie_jobs.outbox_events
              SET available_at=clock_timestamp() -
                CASE WHEN id=$1::uuid THEN interval '2 minutes'
                     ELSE interval '1 minute' END
            WHERE id=ANY($2::uuid[])`,
          [first, [first, second]],
        );

        // The real database supplies the ROLLBACK/COMMIT command tag. Lost
        // ACK is injected only after real COMMIT, not a simulated database.
        const commands: string[] = [];
        const releases: boolean[] = [];
        let tag: string | undefined;
        const faultPool = {
          query: (sql: string, params?: unknown[]) => pool.query(sql, params),
          async connect(): Promise<PoolClient> {
            const physical = await pool.connect();
            return {
              async query(sql: string, params?: unknown[]): Promise<unknown> {
                commands.push(sql);
                if (sql === "COMMIT") {
                  if (mode === "abort") {
                    await assert.rejects(physical.query("SELECT 1 / 0"), {
                      code: "22012",
                    });
                  }
                  const result = await physical.query(sql);
                  tag = result.command;
                  if (mode === "lose-ack") {
                    throw new Error("SYNTHETIC_DISPATCH_ACK_LOST");
                  }
                  return result;
                }
                return physical.query(sql, params);
              },
              release(discard: boolean): void {
                releases.push(discard);
                physical.release(discard);
              },
            } as unknown as PoolClient;
          },
        } as unknown as Pool;

        const keys: string[] = [];
        const deliver = idempotentProviderHandler({
          supportsIdempotencyKey: true,
          async send(event) {
            keys.push(event.idempotencyKey);
          },
        });
        const shutdown = new AbortController();
        let handlerAborted = false;
        const reports: string[] = [];
        await assert.rejects(
          runTrustedPostgresOutboxWorker(
            faultPool,
            async (lease, signal) => {
              signal.addEventListener(
                "abort",
                () => {
                  handlerAborted = true;
                },
                { once: true },
              );
              await deliver(lease);
            },
            {
              signal: shutdown.signal,
              topic,
              leaseMs: 10000,
              handlerTimeoutMs: 1000,
              idleDelayMs: 10,
              busyDelayMs: 10,
              observe(sample) {
                reports.push(sample.kind);
                // Old unsafe code would report a completed batch. Stop it
                // deterministically rather than leaving a failing test hung.
                if (sample.kind === "batch") shutdown.abort();
              },
            },
          ),
          /Outbox supervisor stopped after abandoned lease/,
        );
        assert.equal(tag, mode === "abort" ? "ROLLBACK" : "COMMIT");
        assert.deepEqual(releases, [true]);
        assert.equal(commands.filter((sql) => sql === "COMMIT").length, 1);
        assert.equal(commands.includes("ROLLBACK"), false);
        assert.deepEqual(keys, ["outbox:" + first]);
        assert.equal(handlerAborted, true);
        assert.deepEqual(reports, []);

        async function state() {
          const result = await pool.query<{
            id: string;
            status: string;
            attempts: number;
            delivered_at: Date | null;
            last_failure_code: string | null;
          }>(
            `SELECT id::text,status,attempts,delivered_at,last_failure_code
               FROM cookie_jobs.outbox_events WHERE id=ANY($1::uuid[])`,
            [[first, second]],
          );
          const rows = new Map(result.rows.map((row) => [row.id, row]));
          return [first, second].map((id) => {
            const row = rows.get(id);
            assert.ok(row);
            return [
              row.status,
              row.attempts,
              row.delivered_at !== null,
              row.last_failure_code,
            ];
          });
        }
        assert.deepEqual(await state(), [
          ["leased", 1, false, null],
          ["pending", 0, false, null],
        ]);

        // Expire only the abandoned lease deterministically. Recovery must
        // be on a fresh fenced claim with the original provider key.
        await pool.query(
          `UPDATE cookie_jobs.outbox_events
              SET lease_until=clock_timestamp()-interval '3 minutes'
            WHERE id=$1::uuid AND status='leased'`,
          [first],
        );
        const recovery = new AbortController();
        const totals = await runTrustedPostgresOutboxWorker(
          pool,
          async (lease) => {
            assert.equal(lease.id, first);
            await deliver(lease);
          },
          {
            signal: recovery.signal,
            topic,
            leaseMs: 10000,
            handlerTimeoutMs: 1000,
            idleDelayMs: 10,
            busyDelayMs: 10,
            observe(sample) {
              if (sample.kind === "batch") recovery.abort();
            },
          },
        );
        assert.deepEqual(totals, {
          claimed: 1,
          delivered: 1,
          failed: 0,
          stale: 0,
        });
        assert.deepEqual(keys, ["outbox:" + first, "outbox:" + first]);
        assert.deepEqual(await state(), [
          ["delivered", 2, true, null],
          ["pending", 0, false, null],
        ]);
      }
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid",
          [tenant],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenant],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [owner],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
