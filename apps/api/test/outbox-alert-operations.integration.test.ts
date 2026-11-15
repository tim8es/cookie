import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  claimOutboxAlertDeliveries,
  failOutboxAlertDelivery,
} from "../../../packages/platform-db/src/outbox-alert-delivery.js";
import {
  renewOutboxAlertDeliveryLease,
  replayDeadOutboxAlertDelivery,
  type ReplayDeadAlertRequest,
} from "../../../packages/platform-db/src/outbox-alert-operations.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

const syntheticOperatorAuthorized = async (): Promise<void> => undefined;

test(
  "alert dead-letter replay is audited, transaction-safe, bounded and idempotent across two pools",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const config = { connectionString: process.env.TEST_DATABASE_URL, max: 8 };
    const poolA = new Pool({
      ...config,
      application_name: "cookie-alert-replay-a",
    });
    const poolB = new Pool({
      ...config,
      application_name: "cookie-alert-replay-b",
    });
    const operatorId = randomUUID();
    const revision = String(randomInt(2_000_000_000, 3_000_000_000));
    let ids: string[] = [];
    let clearFault: (() => Promise<void>) | undefined;

    try {
      await runMigrations(poolA, resolve(process.cwd(), "db/migrations"));
      await poolA.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [operatorId],
      );
      const seeded = await poolA.query<{ id: string }>(
        `INSERT INTO cookie_jobs.outbox_alert_transitions
           (revision, code, kind, severity)
         VALUES ($1::bigint,'DUE_BACKLOG','raised','warning'),
                ($1::bigint,'DEAD_LETTERS','raised','critical')
         RETURNING id::text`,
        [revision],
      );
      ids = seeded.rows.map((row) => row.id);
      assert.equal(ids.length, 2);
      const target = ids[0]!;
      await poolA.query(
        "UPDATE cookie_jobs.outbox_alert_delivery SET max_attempts=1 WHERE transition_id=$1::bigint",
        [target],
      );
      const initial = await claimOutboxAlertDeliveries(poolA, {
        batchSize: 2,
        leaseMs: 60_000,
      });
      assert.equal(initial.length, 2);
      const first = initial.find((lease) => lease.transitionId === target);
      assert.ok(first);
      assert.equal(
        await failOutboxAlertDelivery(poolA, first, "SYNTHETIC_FIRST", 0),
        true,
      );

      const request: ReplayDeadAlertRequest = {
        operator: {
          identityId: operatorId,
          correlationId: "qa-replay-operator",
        },
        transitionId: target,
        idempotencyKey: "operator-replay-one",
      };
      await assert.rejects(
        replayDeadOutboxAlertDelivery(poolB, request, async () => {
          throw new Error("DENIED");
        }),
        /Outbox alert replay refused/,
      );
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          replayDeadOutboxAlertDelivery(
            index % 2 ? poolA : poolB,
            request,
            syntheticOperatorAuthorized,
          ),
        ),
      );
      assert.equal(
        attempts.every((result) => result.requeued && result.replayCount === 1),
        true,
      );
      await assert.rejects(
        replayDeadOutboxAlertDelivery(
          poolA,
          { ...request, transitionId: ids[1]! },
          syntheticOperatorAuthorized,
        ),
        /Outbox alert replay refused/,
      );

      const failAfterReplay = async (): Promise<void> => {
        const leases = await claimOutboxAlertDeliveries(poolA, {
          batchSize: 1,
          leaseMs: 60_000,
        });
        assert.equal(leases.length, 1);
        assert.equal(leases[0]?.transitionId, target);
        assert.equal(leases[0]?.attempts, 1);
        assert.equal(
          await failOutboxAlertDelivery(
            poolA,
            leases[0]!,
            "SYNTHETIC_REPEAT",
            0,
          ),
          true,
        );
      };
      await failAfterReplay();

      // Fail AFTER delivery state update but BEFORE replay audit/receipt COMMIT.
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const fn = `cookie_qa_replay_fault_${suffix}`;
      const trigger = `cookie_qa_replay_trigger_${suffix}`;
      await poolA.query(
        `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.replay_number=2 THEN
               RAISE EXCEPTION 'QA_REPLAY_AUDIT_FAIL' USING ERRCODE='P0001';
             END IF;
             RETURN NEW;
           END $$`,
      );
      await poolA.query(
        `CREATE TRIGGER ${trigger}
           BEFORE INSERT ON cookie_jobs.outbox_alert_replay_audit
           FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
      );
      clearFault = async () => {
        try {
          await poolA.query(
            `DROP TRIGGER IF EXISTS ${trigger} ON cookie_jobs.outbox_alert_replay_audit`,
          );
        } finally {
          await poolA.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
        }
      };

      const second = { ...request, idempotencyKey: "operator-replay-two" };
      await assert.rejects(
        replayDeadOutboxAlertDelivery(
          poolB,
          second,
          syntheticOperatorAuthorized,
        ),
        /Outbox alert replay refused/,
      );
      const rolled = await poolA.query<{
        status: string;
        attempts: number;
        manual_replay_count: number;
      }>(
        `SELECT status, attempts, manual_replay_count
           FROM cookie_jobs.outbox_alert_delivery WHERE transition_id=$1::bigint`,
        [target],
      );
      assert.deepEqual(rolled.rows[0], {
        status: "dead",
        attempts: 1,
        manual_replay_count: 1,
      });
      await clearFault();
      clearFault = undefined;

      assert.deepEqual(
        await replayDeadOutboxAlertDelivery(
          poolB,
          second,
          syntheticOperatorAuthorized,
        ),
        { requeued: true, replayCount: 2 },
      );
      await failAfterReplay();
      assert.deepEqual(
        await replayDeadOutboxAlertDelivery(
          poolA,
          { ...request, idempotencyKey: "operator-replay-three" },
          syntheticOperatorAuthorized,
        ),
        { requeued: true, replayCount: 3 },
      );
      await failAfterReplay();

      const fourth = { ...request, idempotencyKey: "operator-replay-four" };
      assert.deepEqual(
        await replayDeadOutboxAlertDelivery(
          poolB,
          fourth,
          syntheticOperatorAuthorized,
        ),
        { requeued: false, replayCount: 3 },
      );
      assert.deepEqual(
        await replayDeadOutboxAlertDelivery(
          poolA,
          fourth,
          syntheticOperatorAuthorized,
        ),
        { requeued: false, replayCount: 3 },
      );
      assert.deepEqual(
        await replayDeadOutboxAlertDelivery(
          poolB,
          request,
          syntheticOperatorAuthorized,
        ),
        { requeued: true, replayCount: 1 },
        "the first key must return its original committed receipt after later attempts",
      );

      const audit = await poolA.query<{
        replay_number: number;
        previous_attempts: number;
      }>(
        `SELECT replay_number, previous_attempts
           FROM cookie_jobs.outbox_alert_replay_audit
          WHERE transition_id=$1::bigint ORDER BY replay_number`,
        [target],
      );
      assert.deepEqual(
        audit.rows.map((row) => row.replay_number),
        [1, 2, 3],
      );
      assert.equal(
        audit.rows.every((row) => row.previous_attempts === 1),
        true,
      );
      const receipts = await poolA.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM cookie_jobs.outbox_alert_replay_receipts
           WHERE transition_id=$1::bigint`,
        [target],
      );
      assert.equal(receipts.rows[0]?.count, "4");
      const rawKeyCheck = await poolA.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM cookie_jobs.outbox_alert_replay_receipts
           WHERE key_sha256 LIKE '%operator-replay%'`,
      );
      assert.equal(rawKeyCheck.rows[0]?.count, "0");
    } finally {
      if (clearFault) await clearFault().catch(() => undefined);
      try {
        if (ids.length) {
          for (const table of [
            "cookie_jobs.outbox_alert_replay_receipts",
            "cookie_jobs.outbox_alert_replay_audit",
            "cookie_jobs.outbox_alert_delivery",
            "cookie_jobs.outbox_alert_transitions",
          ]) {
            await poolA.query(
              `DELETE FROM ${table} WHERE ${table.includes("transitions") ? "id" : "transition_id"}::text=ANY($1::text[])`,
              [ids],
            );
          }
        }
        await poolA.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [operatorId],
        );
      } finally {
        await Promise.all([poolA.end(), poolB.end()]);
      }
    }
  },
);

test(
  "lease renewal uses valid fencing token, denies expired and caps each attempt to 15 minutes",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-alert-heartbeat",
      max: 4,
    });
    const revision = String(randomInt(3_000_000_000, 4_000_000_000));
    let transitionId = "";
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO cookie_jobs.outbox_alert_transitions
           (revision, code, kind, severity)
         VALUES ($1::bigint,'OLDEST_DUE','raised','warning')
         RETURNING id::text`,
        [revision],
      );
      transitionId = inserted.rows[0]!.id;
      const claims = await claimOutboxAlertDeliveries(pool, {
        batchSize: 1,
        leaseMs: 2_000,
      });
      assert.equal(claims.length, 1);
      const first = claims[0]!;
      assert.equal(first.transitionId, transitionId);
      assert.equal(
        await renewOutboxAlertDeliveryLease(pool, first, 30_000),
        true,
      );
      assert.equal(
        await renewOutboxAlertDeliveryLease(pool, first, 1_000),
        false,
      );
      assert.equal(
        await renewOutboxAlertDeliveryLease(
          pool,
          { ...first, leaseToken: randomUUID() },
          60_000,
        ),
        false,
      );
      await pool.query(
        `UPDATE cookie_jobs.outbox_alert_delivery
            SET lease_started_at=clock_timestamp()-interval '16 minutes'
          WHERE transition_id=$1::bigint`,
        [transitionId],
      );
      assert.equal(
        await renewOutboxAlertDeliveryLease(pool, first, 60_000),
        false,
      );
      await pool.query(
        "UPDATE cookie_jobs.outbox_alert_delivery SET lease_started_at=NULL WHERE transition_id=$1::bigint",
        [transitionId],
      );
      assert.equal(
        await renewOutboxAlertDeliveryLease(pool, first, 60_000),
        false,
      );
      await pool.query(
        `UPDATE cookie_jobs.outbox_alert_delivery
            SET lease_until=clock_timestamp()-interval '2 seconds'
          WHERE transition_id=$1::bigint`,
        [transitionId],
      );
      assert.equal(
        await renewOutboxAlertDeliveryLease(pool, first, 60_000),
        false,
      );
      const reclaimed = await claimOutboxAlertDeliveries(pool, {
        batchSize: 1,
        leaseMs: 10_000,
      });
      assert.equal(reclaimed[0]?.attempts, 2);
      assert.notEqual(reclaimed[0]?.leaseToken, first.leaseToken);
      assert.equal(
        await renewOutboxAlertDeliveryLease(pool, first, 60_000),
        false,
      );
      assert.equal(
        await renewOutboxAlertDeliveryLease(pool, reclaimed[0]!, 60_000),
        true,
      );
    } finally {
      try {
        if (transitionId) {
          await pool.query(
            "DELETE FROM cookie_jobs.outbox_alert_delivery WHERE transition_id=$1::bigint",
            [transitionId],
          );
          await pool.query(
            "DELETE FROM cookie_jobs.outbox_alert_transitions WHERE id=$1::bigint",
            [transitionId],
          );
        }
      } finally {
        await pool.end();
      }
    }
  },
);
