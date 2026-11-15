import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { enqueueOutbox } from "../../../packages/platform-db/src/outbox.js";
import {
  readOutboxQueueMetrics,
  runTrustedPostgresOutboxWorker,
} from "../../../packages/platform-db/src/worker.js";

test(
  "worker processes one committed synthetic event and aggregate queue metrics",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-worker-integration",
      max: 3,
    });
    const owner = randomUUID();
    const tenantId = randomUUID();
    let eventId = "";
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
         VALUES($1::uuid, $2::uuid, 'Synthetic worker integration')`,
        [tenantId, owner],
      );
      const baseline = await readOutboxQueueMetrics(pool);
      const client = await pool.connect();
      try {
        eventId = (
          await enqueueOutbox(client, {
            tenantId,
            dedupeKey: "worker-1",
            topic: "booking.confirmed",
            payload: { synthetic: true },
          })
        ).id;
      } finally {
        client.release();
      }
      const before = await readOutboxQueueMetrics(pool);
      assert.equal(before.pending, baseline.pending + 1);
      assert.equal(before.due, baseline.due + 1);

      const controller = new AbortController();
      const processed: string[] = [];
      const totals = await runTrustedPostgresOutboxWorker(
        pool,
        async (event) => {
          processed.push(event.id);
          assert.equal(event.id, eventId);
          assert.equal(event.tenantId, tenantId);
          assert.deepEqual(event.payload, { synthetic: true });
          controller.abort();
        },
        {
          signal: controller.signal,
          leaseMs: 30_000,
          idleDelayMs: 10,
          busyDelayMs: 10,
        },
      );
      assert.deepEqual(totals, {
        claimed: 1,
        delivered: 1,
        failed: 0,
        stale: 0,
      });
      assert.deepEqual(processed, [eventId]);
      const after = await readOutboxQueueMetrics(pool);
      assert.equal(after.pending, baseline.pending);
      assert.equal(after.delivered, baseline.delivered + 1);
      assert.equal(after.oldestDueSeconds >= 0, true);
      assert.throws(
        () =>
          runTrustedPostgresOutboxWorker(pool, async () => undefined, {
            signal: controller.signal,
            leaseMs: 0,
          }),
        /Invalid outbox lease duration/,
      );
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenantId],
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
