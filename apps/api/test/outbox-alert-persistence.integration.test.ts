import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { reconcileOutboxAlertsDurably } from "../../../packages/platform-db/src/outbox-alert-persistence.js";
import type { OutboxHealthPolicy } from "../../../packages/platform-db/src/outbox-health.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  claimOutbox,
  enqueueOutbox,
  failOutbox,
} from "../../../packages/platform-db/src/outbox.js";
import { readOutboxQueueMetrics } from "../../../packages/platform-db/src/worker.js";

interface PersistedMonitor {
  active: Record<string, "warning" | "critical">;
  revision: string;
}

test(
  "two replica pools durably dedupe alert transitions through restart and atomic failure",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const database = process.env.TEST_DATABASE_URL!;
    const poolA = new Pool({
      connectionString: database,
      application_name: "cookie-alert-replica-a",
      max: 12,
    });
    const poolB = new Pool({
      connectionString: database,
      application_name: "cookie-alert-replica-b",
      max: 12,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    let initial: PersistedMonitor | undefined;
    let faultCleanup: (() => Promise<void>) | undefined;
    try {
      await runMigrations(poolA, resolve(process.cwd(), "db/migrations"));
      const initialResult = await poolA.query<PersistedMonitor>(
        `SELECT active, revision::text
           FROM cookie_jobs.outbox_alert_state WHERE singleton=true`,
      );
      initial = initialResult.rows[0];
      assert.ok(initial);
      assert.deepEqual(
        initial.active,
        {},
        "isolated CI starts with empty monitor",
      );

      const before = await readOutboxQueueMetrics(poolA);
      const ignore = Number.MAX_SAFE_INTEGER - 100;
      const policy: OutboxHealthPolicy = {
        due: { warning: before.due, critical: before.due + 10 },
        dead: { warning: before.dead, critical: before.dead + 10 },
        oldestDueSeconds: { warning: ignore, critical: ignore },
        expiredLeases: { warning: ignore, critical: ignore },
      };
      await poolA.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
        [owner],
      );
      await poolA.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES($1::uuid,$2::uuid,'Synthetic durable alerts')`,
        [tenant, owner],
      );

      const producer = await poolA.connect();
      let eventId = "";
      try {
        eventId = (
          await enqueueOutbox(producer, {
            tenantId: tenant,
            dedupeKey: "durable-health-test",
            topic: "qa.durable",
            payload: { synthetic: true },
            availableAt: new Date(Date.now() - 1_000),
            maxAttempts: 1,
          })
        ).id;
      } finally {
        producer.release();
      }

      const burst = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          reconcileOutboxAlertsDurably(i % 2 === 0 ? poolA : poolB, policy),
        ),
      );
      assert.equal(
        burst.flatMap((entry) => entry.transitions).length,
        1,
        "20 competing replicas must commit only one raised transition",
      );
      assert.deepEqual(
        burst.flatMap((entry) => entry.transitions),
        [{ kind: "raised", code: "DUE_BACKLOG", severity: "warning" }],
      );
      const firstRevision = (BigInt(initial.revision) + 1n).toString();
      assert.equal(
        burst.every((entry) => entry.revision === firstRevision),
        true,
      );

      // A newly started replica uses the persisted singleton, not a fresh
      // in-memory state. An unchanged sample cannot duplicate the alert.
      const restarted = new Pool({
        connectionString: database,
        application_name: "cookie-alert-restarted-replica",
        max: 2,
      });
      try {
        const result = await reconcileOutboxAlertsDurably(restarted, policy);
        assert.equal(result.revision, firstRevision);
        assert.deepEqual(result.transitions, []);
        assert.deepEqual(result.state.active, { DUE_BACKLOG: "warning" });
      } finally {
        await restarted.end();
      }

      const leased = await claimOutbox(poolA, {
        batchSize: 1,
        topic: "qa.durable",
      });
      assert.equal(leased.length, 1);
      assert.equal(leased[0]?.id, eventId);
      assert.equal(
        await failOutbox(poolA, leased[0]!, "QA_DURABLE_FAILURE", 0),
        true,
      );

      // Inject an exception at journal insert, AFTER state UPDATE.
      // Transaction rollback must preserve the previously committed state.
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const trigger = `cookie_qa_alert_trigger_${suffix}`;
      const functionName = `cookie_qa_alert_fault_${suffix}`;
      await poolA.query(
        `CREATE FUNCTION public.${functionName}() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.code = 'DEAD_LETTERS' THEN
             RAISE EXCEPTION 'SYNTHETIC_ALERT_JOURNAL_FAILURE'
               USING ERRCODE='P0001';
           END IF;
           RETURN NEW;
         END $$`,
      );
      await poolA.query(
        `CREATE TRIGGER ${trigger}
           BEFORE INSERT ON cookie_jobs.outbox_alert_transitions
           FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`,
      );
      faultCleanup = async () => {
        try {
          await poolA.query(
            `DROP TRIGGER IF EXISTS ${trigger}
               ON cookie_jobs.outbox_alert_transitions`,
          );
        } finally {
          await poolA.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
        }
      };
      await assert.rejects(
        reconcileOutboxAlertsDurably(poolB, policy),
        /Outbox alert persistence failed/,
      );
      const duringFailure = await poolA.query<PersistedMonitor>(
        `SELECT active, revision::text
           FROM cookie_jobs.outbox_alert_state WHERE singleton=true`,
      );
      assert.deepEqual(duringFailure.rows[0], {
        active: { DUE_BACKLOG: "warning" },
        revision: firstRevision,
      });
      const journalCount = await poolA.query<{ count: string }>(
        "SELECT count(*)::text FROM cookie_jobs.outbox_alert_transitions",
      );
      assert.equal(journalCount.rows[0]?.count, "1");
      await faultCleanup();
      faultCleanup = undefined;

      const changed = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          reconcileOutboxAlertsDurably(i % 2 === 0 ? poolA : poolB, policy),
        ),
      );
      assert.equal(
        changed.flatMap((entry) => entry.transitions).length,
        2,
        "first healthy retry after rollback must commit two transitions once",
      );
      assert.deepEqual(
        changed.flatMap((entry) => entry.transitions),
        [
          {
            kind: "resolved",
            code: "DUE_BACKLOG",
            previousSeverity: "warning",
          },
          { kind: "raised", code: "DEAD_LETTERS", severity: "warning" },
        ],
      );
      assert.equal(
        changed.every(
          (entry) => entry.revision === (BigInt(firstRevision) + 1n).toString(),
        ),
        true,
      );

      await poolA.query(
        `DELETE FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, eventId],
      );
      const recovered = await reconcileOutboxAlertsDurably(poolB, policy);
      assert.deepEqual(recovered.transitions, [
        { kind: "resolved", code: "DEAD_LETTERS", previousSeverity: "warning" },
      ]);
      assert.deepEqual(recovered.state.active, {});
      const nothing = await reconcileOutboxAlertsDurably(poolA, policy);
      assert.deepEqual(nothing.transitions, []);

      const persisted = await poolA.query<{
        code: string;
        kind: string;
        revision: string;
      }>(
        `SELECT code, kind, revision::text
           FROM cookie_jobs.outbox_alert_transitions ORDER BY id`,
      );
      assert.deepEqual(
        persisted.rows.map(({ code, kind }) => [code, kind]),
        [
          ["DUE_BACKLOG", "raised"],
          ["DUE_BACKLOG", "resolved"],
          ["DEAD_LETTERS", "raised"],
          ["DEAD_LETTERS", "resolved"],
        ],
      );
      assert.equal(
        new Set(persisted.rows.map((entry) => entry.revision)).size,
        3,
      );
    } finally {
      if (faultCleanup) await faultCleanup().catch(() => undefined);
      try {
        if (initial) {
          // Migration 0016 attaches delivery rows to every journal transition.
          // Clear synthetic delivery receipts before deleting their parent.
          await poolA.query(
            `DELETE FROM cookie_jobs.outbox_alert_delivery
              WHERE transition_id IN (
                SELECT id FROM cookie_jobs.outbox_alert_transitions
                WHERE revision > $1::bigint
              )`,
            [initial.revision],
          );
          await poolA.query(
            `DELETE FROM cookie_jobs.outbox_alert_transitions
               WHERE revision > $1::bigint`,
            [initial.revision],
          );
          await poolA.query(
            `UPDATE cookie_jobs.outbox_alert_state
               SET active=$1::jsonb, revision=$2::bigint
             WHERE singleton=true`,
            [JSON.stringify(initial.active), initial.revision],
          );
        }
        await poolA.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid",
          [tenant],
        );
        await poolA.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenant],
        );
        await poolA.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [owner],
        );
      } finally {
        await Promise.all([poolA.end(), poolB.end()]);
      }
    }
  },
);
