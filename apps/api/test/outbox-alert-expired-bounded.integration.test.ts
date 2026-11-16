import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  acknowledgeOutboxAlertDelivery,
  claimOutboxAlertDeliveries,
} from "../../../packages/platform-db/src/outbox-alert-delivery.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "alert expired-final-lease maintenance has a bounded budget before ready delivery",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-alert-bounded-expiry",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const revision = String(randomInt(20_000_000_000, 21_000_000_000));
    const ids: string[] = [];
    const expiredCount = 70;
    const limit = 25;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const seeded = await pool.query<{ id: string }>(
        `INSERT INTO cookie_jobs.outbox_alert_transitions
           (revision, code, kind, severity)
         SELECT $1::bigint + series.n, 'DUE_BACKLOG', 'raised', 'warning'
           FROM generate_series(1, $2::integer) AS series(n)
         RETURNING id::text`,
        [revision, expiredCount + 1],
      );
      ids.push(...seeded.rows.map((row) => row.id));
      assert.equal(ids.length, expiredCount + 1);
      const readyId = ids[expiredCount]!;

      const exhaustedIds = ids.slice(0, expiredCount);
      const updated = await pool.query(
        `UPDATE cookie_jobs.outbox_alert_delivery
            SET status='leased', attempts=1, max_attempts=1,
                lease_token=gen_random_uuid(),
                lease_started_at=clock_timestamp()-interval '2 seconds',
                lease_until=clock_timestamp()-interval '1 second'
          WHERE transition_id::text=ANY($1::text[])`,
        [exhaustedIds],
      );
      assert.equal(updated.rowCount, expiredCount);

      const statuses = async (): Promise<Record<string, number>> => {
        const result = await pool.query<{
          status: string;
          count: number;
        }>(
          `SELECT status, count(*)::integer AS count
             FROM cookie_jobs.outbox_alert_delivery
            WHERE transition_id::text=ANY($1::text[])
            GROUP BY status`,
          [ids],
        );
        return Object.fromEntries(
          result.rows.map((row) => [row.status, row.count]),
        );
      };

      const started = performance.now();
      const claimed = await claimOutboxAlertDeliveries(pool, {
        batchSize: 1,
        leaseMs: 30_000,
      });
      const durationMs = Math.round(performance.now() - started);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.transitionId, readyId);
      assert.equal(claimed[0]?.attempts, 1);
      assert.equal(
        await acknowledgeOutboxAlertDelivery(pool, claimed[0]!),
        true,
      );
      assert.deepEqual(await statuses(), {
        dead: limit,
        leased: expiredCount - limit,
        delivered: 1,
      });

      console.info(
        "synthetic bounded alert expiry: " +
          JSON.stringify({
            reaped: limit,
            remaining: expiredCount - limit,
            readyDelivered: 1,
            durationMs,
          }),
      );

      assert.deepEqual(
        await claimOutboxAlertDeliveries(pool, { batchSize: 1 }),
        [],
      );
      assert.deepEqual(await statuses(), {
        dead: limit * 2,
        leased: expiredCount - limit * 2,
        delivered: 1,
      });

      assert.deepEqual(
        await claimOutboxAlertDeliveries(pool, { batchSize: 1 }),
        [],
      );
      assert.deepEqual(await statuses(), {
        dead: expiredCount,
        delivered: 1,
      });

      assert.deepEqual(
        await claimOutboxAlertDeliveries(pool, { batchSize: 1 }),
        [],
      );
      assert.deepEqual(await statuses(), {
        dead: expiredCount,
        delivered: 1,
      });
    } finally {
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
        await pool.end();
      }
    }
  },
);
