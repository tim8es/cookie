import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  acknowledgeOutboxAlertDelivery,
  claimOutboxAlertDeliveries,
} from "../../../packages/platform-db/src/outbox-alert-delivery.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "locked expired final-attempt alert cannot block claiming a separate due alert",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-alert-expired-lock-holder",
      max: 3,
    });
    const claimingPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-alert-expired-lock-claim",
      options: "-c lock_timeout=300ms",
      max: 2,
    });
    const revision = String(randomInt(12_000_000_000, 13_000_000_000));
    let ids: string[] = [];
    let lockedTransaction = false;
    const locker = await pool.connect();
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));

      const exhausted = await pool.query<{ id: string }>(
        `INSERT INTO cookie_jobs.outbox_alert_transitions
           (revision, code, kind, severity)
         VALUES ($1::bigint, 'DEAD_LETTERS', 'raised', 'critical')
         RETURNING id::text`,
        [revision],
      );
      const exhaustedId = exhausted.rows[0]!.id;
      ids.push(exhaustedId);
      const first = await claimOutboxAlertDeliveries(pool, {
        batchSize: 1,
        leaseMs: 60_000,
      });
      assert.equal(first.length, 1);
      assert.equal(first[0]?.transitionId, exhaustedId);

      await pool.query(
        `UPDATE cookie_jobs.outbox_alert_delivery
            SET max_attempts=1,
                lease_until=clock_timestamp()-interval '1 second'
          WHERE transition_id=$1::bigint`,
        [exhaustedId],
      );

      const ready = await pool.query<{ id: string }>(
        `INSERT INTO cookie_jobs.outbox_alert_transitions
           (revision, code, kind, severity)
         VALUES ($1::bigint, 'DUE_BACKLOG', 'raised', 'warning')
         RETURNING id::text`,
        [revision],
      );
      const readyId = ready.rows[0]!.id;
      ids.push(readyId);

      // Hold a PostgreSQL row lock on the exhausted transition while the
      // second worker queries. The previous unconditional UPDATE would hit
      // its 300ms lock_timeout before reaching the SKIP LOCKED claim.
      await locker.query("BEGIN");
      lockedTransaction = true;
      await locker.query(
        `SELECT transition_id FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint FOR UPDATE`,
        [exhaustedId],
      );

      const available = await claimOutboxAlertDeliveries(claimingPool, {
        batchSize: 1,
        leaseMs: 30_000,
      });
      assert.equal(available.length, 1);
      assert.equal(available[0]?.transitionId, readyId);
      assert.equal(available[0]?.attempts, 1);
      assert.equal(
        await acknowledgeOutboxAlertDelivery(claimingPool, available[0]!),
        true,
      );

      const beforeUnlock = await claimingPool.query<{
        status: string;
        attempts: number;
        lease_token: string;
        lease_until: Date;
      }>(
        `SELECT status, attempts, lease_token::text, lease_until
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [exhaustedId],
      );
      assert.equal(beforeUnlock.rows[0]?.status, "leased");
      assert.equal(beforeUnlock.rows[0]?.attempts, 1);
      assert.equal(beforeUnlock.rows[0]?.lease_token, first[0]!.leaseToken);
      assert.ok(
        beforeUnlock.rows[0]!.lease_until.getTime() < Date.now(),
        "a skipped expired lease must not be renewed or acknowledged",
      );

      await locker.query("COMMIT");
      lockedTransaction = false;

      assert.deepEqual(
        await claimOutboxAlertDeliveries(claimingPool, { batchSize: 1 }),
        [],
      );
      const afterUnlock = await claimingPool.query<{
        status: string;
        last_failure_code: string;
        lease_token: string | null;
        lease_until: Date | null;
      }>(
        `SELECT status, last_failure_code, lease_token::text, lease_until
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [exhaustedId],
      );
      assert.deepEqual(afterUnlock.rows[0], {
        status: "dead",
        last_failure_code: "LEASE_EXHAUSTED",
        lease_token: null,
        lease_until: null,
      });
      assert.equal(
        await acknowledgeOutboxAlertDelivery(claimingPool, first[0]!),
        false,
      );
      const delivered = await claimingPool.query<{ status: string }>(
        `SELECT status FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [readyId],
      );
      assert.equal(delivered.rows[0]?.status, "delivered");
    } finally {
      if (lockedTransaction)
        await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
      try {
        if (ids.length) {
          await pool.query(
            `DELETE FROM cookie_jobs.outbox_alert_delivery
               WHERE transition_id::text=ANY($1::text[])`,
            [ids],
          );
          await pool.query(
            `DELETE FROM cookie_jobs.outbox_alert_transitions
               WHERE id::text=ANY($1::text[])`,
            [ids],
          );
        }
      } finally {
        await Promise.all([pool.end(), claimingPool.end()]);
      }
    }
  },
);
