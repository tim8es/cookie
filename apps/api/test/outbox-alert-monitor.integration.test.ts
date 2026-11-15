import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  superviseOutboxHealth,
  type OutboxAlertTransition,
} from "../../../packages/platform-db/src/outbox-alert-monitor.js";
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
  "trusted single-flight monitor deduplicates real PostgreSQL backlog, dead-letter and recovery changes",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-outbox-alert-monitor-integration",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const ownerId = randomUUID();
    const topic = "qa.monitor";
    const controller = new AbortController();
    const reported: OutboxAlertTransition[] = [];
    const observed: string[] = [];
    let cycles = 0;
    let dueId = "";
    let futureId = "";

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
        [ownerId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id, owner_identity_id, display_name)
         VALUES ($1::uuid, $2::uuid, 'Synthetic alert monitor')`,
        [tenantId, ownerId],
      );

      const baseline = await readOutboxQueueMetrics(pool);
      const ignoreThreshold = Number.MAX_SAFE_INTEGER - 10;
      const policy: OutboxHealthPolicy = {
        due: { warning: baseline.due, critical: baseline.due + 2 },
        dead: { warning: baseline.dead, critical: baseline.dead + 2 },
        oldestDueSeconds: {
          warning: ignoreThreshold,
          critical: ignoreThreshold,
        },
        expiredLeases: {
          warning: ignoreThreshold,
          critical: ignoreThreshold,
        },
      };

      const producer = await pool.connect();
      try {
        dueId = (
          await enqueueOutbox(producer, {
            tenantId,
            topic,
            dedupeKey: "monitor-due",
            payload: { synthetic: true },
            availableAt: new Date(Date.now() - 1_000),
            maxAttempts: 1,
          })
        ).id;
        futureId = (
          await enqueueOutbox(producer, {
            tenantId,
            topic,
            dedupeKey: "monitor-future",
            payload: { synthetic: true },
            availableAt: new Date(Date.now() + 3_600_000),
            maxAttempts: 1,
          })
        ).id;
      } finally {
        producer.release();
      }

      const final = await superviseOutboxHealth({
        signal: controller.signal,
        intervalMs: 10,
        sampleTimeoutMs: 1_000,
        maxConsecutiveUnavailable: 3,
        async sample() {
          cycles++;
          if (cycles === 2) {
            const leased = await claimOutbox(pool, { topic, batchSize: 1 });
            assert.equal(leased.length, 1);
            assert.equal(leased[0]?.id, dueId);
            assert.equal(
              await failOutbox(pool, leased[0]!, "QA_MONITOR_FAILURE", 0),
              true,
            );
          }
          if (cycles === 4) {
            // Simulated operator cleanup after dead-letter triage: health
            // must issue exactly one resolution, not repeated notifications.
            await pool.query(
              "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid AND id=$2::uuid",
              [tenantId, dueId],
            );
          }
          return sampleOutboxHealth(pool, policy);
        },
        onTransition(change) {
          reported.push(change);
        },
        onSample(status) {
          observed.push(status);
          if (observed.length === 4) controller.abort();
        },
      });

      assert.equal(cycles, 4);
      assert.deepEqual(observed, [
        "degraded",
        "degraded",
        "degraded",
        "healthy",
      ]);
      assert.deepEqual(
        reported.map(({ kind, code }) => [kind, code]),
        [
          ["raised", "DUE_BACKLOG"],
          ["resolved", "DUE_BACKLOG"],
          ["raised", "DEAD_LETTERS"],
          ["resolved", "DEAD_LETTERS"],
        ],
      );
      assert.deepEqual(final.active, {});

      const persisted = await pool.query<{
        id: string;
        status: string;
        topic: string;
      }>(
        `SELECT id::text, status, topic
           FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid`,
        [tenantId],
      );
      assert.deepEqual(persisted.rows, [
        { id: futureId, status: "pending", topic },
      ]);
      const metrics = await readOutboxQueueMetrics(pool);
      assert.equal(metrics.due, baseline.due);
      assert.equal(metrics.dead, baseline.dead);
    } finally {
      controller.abort();
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
