import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  acknowledgeOutboxAlertDelivery,
  claimOutboxAlertDeliveries,
  failOutboxAlertDelivery,
  type OutboxAlertDeliveryLease,
} from "../../../packages/platform-db/src/outbox-alert-delivery.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "alert journal queues atomically and separate PostgreSQL workers cannot double-claim",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const poolA = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-alert-delivery-a",
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    const poolB = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-alert-delivery-b",
      max: 8,
      connectionTimeoutMillis: 5_000,
    });

    const revision = String(randomInt(1_000_000_000, 2_000_000_000));
    let created: string[] = [];
    try {
      await runMigrations(poolA, resolve(process.cwd(), "db/migrations"));

      const seed = await poolA.query<{ id: string; code: string }>(
        `INSERT INTO cookie_jobs.outbox_alert_transitions
           (revision, code, kind, severity)
         VALUES
           ($1::bigint,'DUE_BACKLOG','raised','warning'),
           ($1::bigint,'OLDEST_DUE','raised','warning'),
           ($1::bigint,'EXPIRED_LEASES','raised','critical'),
           ($1::bigint,'DEAD_LETTERS','raised','critical')
         RETURNING id::text, code`,
        [revision],
      );
      created = seed.rows.map((row) => row.id);

      const autoQueued = await poolA.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id::text=ANY($1::text[]) AND status='pending'`,
        [created],
      );
      assert.equal(autoQueued.rows[0]?.count, "4");

      // A rolled-back journal mutation cannot leave an orphan queue item.
      const transaction = await poolA.connect();
      let rolledBackId = "";
      try {
        await transaction.query("BEGIN");
        const rolled = await transaction.query<{ id: string }>(
          `INSERT INTO cookie_jobs.outbox_alert_transitions
             (revision, code, kind, severity)
           VALUES ($1::bigint,'DUE_BACKLOG','raised','warning')
           RETURNING id::text`,
          [(BigInt(revision) + 1n).toString()],
        );
        rolledBackId = rolled.rows[0]!.id;
        const visible = await transaction.query(
          `SELECT transition_id FROM cookie_jobs.outbox_alert_delivery
             WHERE transition_id=$1::bigint`,
          [rolledBackId],
        );
        assert.equal(visible.rowCount, 1);
        await transaction.query("ROLLBACK");
      } finally {
        transaction.release();
      }
      const absent = await poolA.query(
        `SELECT transition_id FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [rolledBackId],
      );
      assert.equal(absent.rowCount, 0);

      const bursts = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          claimOutboxAlertDeliveries(index % 2 ? poolB : poolA, {
            batchSize: 1,
            leaseMs: 60_000,
          }),
        ),
      );
      const claimed = bursts.flat();
      assert.equal(claimed.length, 4);
      assert.equal(new Set(claimed.map((row) => row.transitionId)).size, 4);
      assert.deepEqual(
        new Set(claimed.map((row) => row.transitionId)),
        new Set(created),
      );
      assert.equal(
        claimed.every(
          (row) =>
            row.revision === revision &&
            row.attempts === 1 &&
            row.idempotencyKey ===
              "outbox-alert-transition:" + row.transitionId,
        ),
        true,
      );
      assert.deepEqual(
        await claimOutboxAlertDeliveries(poolB, { batchSize: 4 }),
        [],
        "an active lease cannot be claimed by a second worker",
      );

      const byCode = new Map(claimed.map((lease) => [lease.code, lease]));
      const delivered = byCode.get("DUE_BACKLOG")!;
      assert.equal(
        await acknowledgeOutboxAlertDelivery(poolB, delivered),
        true,
      );
      assert.equal(
        await acknowledgeOutboxAlertDelivery(poolA, delivered),
        false,
        "duplicate acknowledgment must not change a delivered item",
      );
      assert.equal(
        await failOutboxAlertDelivery(
          poolB,
          delivered,
          "LATE_HANDLER_ERROR",
          0,
        ),
        false,
      );

      const retryable = byCode.get("OLDEST_DUE")!;
      assert.equal(
        await failOutboxAlertDelivery(
          poolB,
          retryable,
          "SYNTHETIC_PROVIDER_FAILURE",
          0,
        ),
        true,
      );
      const retry = await claimOutboxAlertDeliveries(poolA, {
        batchSize: 1,
      });
      assert.equal(retry.length, 1);
      assert.equal(retry[0]?.transitionId, retryable.transitionId);
      assert.equal(retry[0]?.attempts, 2);
      assert.notEqual(retry[0]?.leaseToken, retryable.leaseToken);
      assert.equal(retry[0]?.idempotencyKey, retryable.idempotencyKey);
      assert.equal(
        await acknowledgeOutboxAlertDelivery(poolB, retryable),
        false,
        "a stale lease token cannot acknowledge newer work",
      );
      assert.equal(
        await acknowledgeOutboxAlertDelivery(poolA, retry[0]!),
        true,
      );

      const exhausted = byCode.get("EXPIRED_LEASES")!;
      await poolA.query(
        `UPDATE cookie_jobs.outbox_alert_delivery
            SET max_attempts=2,
                lease_until=clock_timestamp()-interval '2 seconds'
          WHERE transition_id=$1::bigint`,
        [exhausted.transitionId],
      );
      const reclaimed = await claimOutboxAlertDeliveries(poolB, {
        batchSize: 1,
      });
      assert.equal(reclaimed[0]?.transitionId, exhausted.transitionId);
      assert.equal(reclaimed[0]?.attempts, 2);
      assert.equal(
        await acknowledgeOutboxAlertDelivery(poolA, exhausted),
        false,
      );
      assert.equal(
        await failOutboxAlertDelivery(
          poolB,
          reclaimed[0]!,
          "REPEATED_SYNTHETIC_FAILURE",
          0,
        ),
        true,
      );
      const dead = await poolA.query<{
        status: string;
        attempts: number;
        last_failure_code: string;
      }>(
        `SELECT status, attempts, last_failure_code
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [exhausted.transitionId],
      );
      assert.deepEqual(dead.rows[0], {
        status: "dead",
        attempts: 2,
        last_failure_code: "REPEATED_SYNTHETIC_FAILURE",
      });

      // A process crash on its final allowed attempt is dead-lettered by
      // lease recovery; there is no unbounded lease-expiry retry loop.
      const crashed = byCode.get("DEAD_LETTERS")!;
      await poolA.query(
        `UPDATE cookie_jobs.outbox_alert_delivery
            SET max_attempts=1,
                lease_until=clock_timestamp()-interval '2 seconds'
          WHERE transition_id=$1::bigint`,
        [crashed.transitionId],
      );
      assert.deepEqual(
        await claimOutboxAlertDeliveries(poolB),
        [],
      );
      const status = await poolB.query<{
        status: string;
        attempts: number;
        lease_token: string | null;
        last_failure_code: string;
      }>(
        `SELECT status, attempts, lease_token, last_failure_code
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [crashed.transitionId],
      );
      assert.deepEqual(status.rows[0], {
        status: "dead",
        attempts: 1,
        lease_token: null,
        last_failure_code: "LEASE_EXHAUSTED",
      });

      const totals = await poolA.query<{
        status: string;
        count: string;
      }>(
        `SELECT status, count(*)::text AS count
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id::text=ANY($1::text[])
          GROUP BY status ORDER BY status`,
        [created],
      );
      assert.deepEqual(totals.rows, [
        { status: "dead", count: "2" },
        { status: "delivered", count: "2" },
      ]);
      assert.equal(
        await acknowledgeOutboxAlertDelivery(poolA, crashed),
        false,
      );
    } finally {
      try {
        if (created.length) {
          await poolA.query(
            `DELETE FROM cookie_jobs.outbox_alert_delivery
              WHERE transition_id::text=ANY($1::text[])`,
            [created],
          );
          await poolA.query(
            `DELETE FROM cookie_jobs.outbox_alert_transitions
              WHERE id::text=ANY($1::text[])`,
            [created],
          );
        }
      } finally {
        await Promise.all([poolA.end(), poolB.end()]);
      }
    }
  },
);

test("alert delivery validates untrusted lease metadata and limits before SQL", async () => {
  const fakePool = {
    async query(): Promise<never> {
      assert.fail("invalid inputs must not hit PostgreSQL");
    },
  } as unknown as Pool;

  for (const options of [
    { batchSize: 0 },
    { batchSize: 101 },
    { batchSize: Number.NaN },
    { leaseMs: -1 },
    { leaseMs: 600_001 },
  ]) {
    await assert.rejects(
      claimOutboxAlertDeliveries(fakePool, options),
      /Invalid Outbox alert claim limits/,
    );
  }
  const lease: Pick<
    OutboxAlertDeliveryLease,
    "transitionId" | "leaseToken"
  > = {
    transitionId: "1",
    leaseToken: randomUUID(),
  };
  for (const invalid of [
    { ...lease, transitionId: "0" },
    { ...lease, transitionId: "9223372036854775808" },
    { ...lease, transitionId: "1;drop table" },
    { ...lease, leaseToken: "not-uuid" },
  ]) {
    await assert.rejects(
      acknowledgeOutboxAlertDelivery(fakePool, invalid),
      /Invalid Outbox alert delivery lease/,
    );
  }
  for (const [reason, delay] of [
    ["not-safe-tenant-data", 0],
    ["PRIVATE_CONTACT", -1],
    ["SYNTHETIC_FAILURE", 3_600_001],
  ] as const) {
    await assert.rejects(
      failOutboxAlertDelivery(fakePool, lease, reason, delay),
      /Invalid Outbox alert delivery failure metadata/,
    );
  }
});
