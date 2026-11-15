import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  sampleOutboxHealth,
  type OutboxHealthPolicy,
} from "../../../packages/platform-db/src/outbox-health.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  claimOutbox,
  enqueueOutbox,
  failOutbox,
} from "../../../packages/platform-db/src/outbox.js";
import { readOutboxQueueMetrics } from "../../../packages/platform-db/src/worker.js";

test(
  "private outbox sampler detects a new due backlog and dead letter in real PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-outbox-health-integration",
      max: 4,
    });
    const tenantId = randomUUID();
    const ownerId = randomUUID();
    const topic = "qa.health";
    let dueId = "";
    let futureId = "";
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [ownerId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
          (id, owner_identity_id, display_name)
         VALUES ($1::uuid, $2::uuid, 'Synthetic health queue')`,
        [tenantId, ownerId],
      );

      const baseline = await readOutboxQueueMetrics(pool);
      const high = Number.MAX_SAFE_INTEGER - 100;
      const policy: OutboxHealthPolicy = {
        due: { warning: baseline.due, critical: baseline.due + 1 },
        oldestDueSeconds: { warning: high, critical: high },
        expiredLeases: { warning: high, critical: high },
        dead: { warning: baseline.dead, critical: baseline.dead + 1 },
      };
      assert.equal((await sampleOutboxHealth(pool, policy)).status, "healthy");

      const client = await pool.connect();
      try {
        dueId = (
          await enqueueOutbox(client, {
            tenantId,
            topic,
            dedupeKey: "health-due",
            payload: { synthetic: true },
            maxAttempts: 1,
            availableAt: new Date(Date.now() - 1000),
          })
        ).id;
        futureId = (
          await enqueueOutbox(client, {
            tenantId,
            topic,
            dedupeKey: "health-future",
            payload: { synthetic: true },
            maxAttempts: 1,
            availableAt: new Date(Date.now() + 3_600_000),
          })
        ).id;
      } finally {
        client.release();
      }

      const pending = await sampleOutboxHealth(pool, policy);
      assert.equal(pending.status, "degraded");
      assert.deepEqual(pending.findings, [
        { code: "DUE_BACKLOG", severity: "warning" },
      ]);
      if (pending.status === "unavailable") throw Error("health unavailable");
      assert.equal(pending.metrics.pending, baseline.pending + 2);
      assert.equal(pending.metrics.due, baseline.due + 1);

      // A dead letter should trigger a separate operator action even though
      // its event is no longer counted in the due pending backlog.
      const lease = await claimOutbox(pool, { topic, batchSize: 1 });
      assert.equal(lease.length, 1);
      assert.equal(lease[0]?.id, dueId);
      assert.equal(await failOutbox(pool, lease[0]!, "QA_FAILURE", 0), true);

      const dead = await sampleOutboxHealth(pool, policy);
      assert.equal(dead.status, "degraded");
      assert.deepEqual(dead.findings, [
        { code: "DEAD_LETTERS", severity: "warning" },
      ]);
      if (dead.status === "unavailable") throw Error("health unavailable");
      assert.equal(dead.metrics.dead, baseline.dead + 1);
      assert.equal(dead.metrics.due, baseline.due);
      assert.equal(dead.metrics.pending, baseline.pending + 1);

      const stored = await pool.query<{ status: string }>(
        "SELECT status FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [futureId],
      );
      assert.equal(stored.rows[0]?.status, "pending");
      assert.equal(
        (await pool.query(
          "SELECT count(*)::text AS count FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid",
          [tenantId],
        )).rows[0]?.count,
        "2",
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
          [ownerId],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
