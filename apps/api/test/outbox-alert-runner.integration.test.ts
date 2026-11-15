import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  acknowledgeOutboxAlertDelivery,
  claimOutboxAlertDeliveries,
} from "../../../packages/platform-db/src/outbox-alert-delivery.js";
import { superviseOutboxAlertDelivery } from "../../../packages/platform-db/src/outbox-alert-runner.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

async function seed(
  pool: Pool,
  revision: string,
  codes: readonly string[],
): Promise<string[]> {
  const inserted: string[] = [];
  for (const code of codes) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO cookie_jobs.outbox_alert_transitions
         (revision, code, kind, severity)
       VALUES ($1::bigint, $2, 'raised', 'warning') RETURNING id::text`,
      [revision, code],
    );
    inserted.push(result.rows[0]!.id);
  }
  return inserted;
}

async function cleanup(pool: Pool, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM cookie_jobs.outbox_alert_delivery
       WHERE transition_id::text = ANY($1::text[])`,
    [ids],
  );
  await pool.query(
    `DELETE FROM cookie_jobs.outbox_alert_transitions
       WHERE id::text = ANY($1::text[])`,
    [ids],
  );
}

test(
  "two real PostgreSQL worker pools process four synthetic alerts once each and stop cleanly",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    const poolA = new Pool({
      connectionString,
      application_name: "cookie-alert-runner-worker-a",
      max: 4,
    });
    const poolB = new Pool({
      connectionString,
      application_name: "cookie-alert-runner-worker-b",
      max: 4,
    });
    const left = new AbortController();
    const right = new AbortController();
    const revision = String(randomInt(4_000_000_000, 5_000_000_000));
    const processed = new Map<string, number>();
    let ids: string[] = [];
    const safeguard = setTimeout(() => {
      left.abort();
      right.abort();
    }, 5_000);

    try {
      await runMigrations(poolA, resolve(process.cwd(), "db/migrations"));
      ids = await seed(poolA, revision, [
        "DUE_BACKLOG",
        "OLDEST_DUE",
        "EXPIRED_LEASES",
        "DEAD_LETTERS",
      ]);

      const syntheticAdapter = async (
        lease: { transitionId: string; idempotencyKey: string },
        signal: AbortSignal,
      ): Promise<void> => {
        assert.equal(signal.aborted, false);
        assert.equal(
          lease.idempotencyKey,
          "outbox-alert-transition:" + lease.transitionId,
        );
        processed.set(
          lease.transitionId,
          (processed.get(lease.transitionId) ?? 0) + 1,
        );
        if (processed.size === 4) {
          left.abort();
          right.abort();
        }
        await Promise.resolve();
      };
      const config = {
        leaseMs: 2_000,
        handlerTimeoutMs: 400,
        idleDelayMs: 10,
        busyDelayMs: 10,
        errorDelayMs: 10,
      };
      const [a, b] = await Promise.all([
        superviseOutboxAlertDelivery(poolA, syntheticAdapter, {
          ...config,
          signal: left.signal,
        }),
        superviseOutboxAlertDelivery(poolB, syntheticAdapter, {
          ...config,
          signal: right.signal,
        }),
      ]);
      assert.equal(a.acknowledged + b.acknowledged, 4);
      assert.equal(a.claimed + b.claimed, 4);
      assert.equal(a.stale + b.stale + a.abandoned + b.abandoned, 0);
      assert.deepEqual(new Set(processed.keys()), new Set(ids));
      assert.equal(
        [...processed.values()].every((count) => count === 1),
        true,
      );

      const rows = await poolA.query<{
        transition_id: string;
        status: string;
        attempts: number;
        delivered_at: Date | null;
      }>(
        `SELECT transition_id::text, status, attempts, delivered_at
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id::text=ANY($1::text[])`,
        [ids],
      );
      assert.equal(rows.rows.length, 4);
      assert.equal(
        rows.rows.every(
          (row) =>
            row.status === "delivered" &&
            row.attempts === 1 &&
            row.delivered_at instanceof Date,
        ),
        true,
      );
    } finally {
      clearTimeout(safeguard);
      left.abort();
      right.abort();
      try {
        await cleanup(poolA, ids);
      } finally {
        await Promise.all([poolA.end(), poolB.end()]);
      }
    }
  },
);

test(
  "synthetic handler failure is retried using stable transition key then ACKed",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-alert-runner-retry",
      max: 3,
    });
    const controller = new AbortController();
    const revision = String(randomInt(5_000_000_000, 6_000_000_000));
    let ids: string[] = [];
    const keys: string[] = [];
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      ids = await seed(pool, revision, ["DUE_BACKLOG"]);
      let called = 0;
      const result = await superviseOutboxAlertDelivery(
        pool,
        async (lease) => {
          keys.push(lease.idempotencyKey);
          called++;
          if (called === 1)
            throw new Error("synthetic failure with private data");
          controller.abort();
        },
        {
          signal: controller.signal,
          leaseMs: 1_000,
          handlerTimeoutMs: 300,
          idleDelayMs: 10,
          busyDelayMs: 10,
          retryDelayMs: 0,
        },
      );
      assert.equal(result.claimed, 2);
      assert.equal(result.failed, 1);
      assert.equal(result.acknowledged, 1);
      assert.deepEqual(keys, [
        "outbox-alert-transition:" + ids[0],
        "outbox-alert-transition:" + ids[0],
      ]);
      const stored = await pool.query<{
        status: string;
        attempts: number;
        last_failure_code: string | null;
      }>(
        `SELECT status, attempts, last_failure_code
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [ids[0]],
      );
      assert.deepEqual(stored.rows[0], {
        status: "delivered",
        attempts: 2,
        last_failure_code: null,
      });
    } finally {
      controller.abort();
      try {
        await cleanup(pool, ids);
      } finally {
        await pool.end();
      }
    }
  },
);

test(
  "timed-out uncooperative handler never ACKs, and expired lease is safely reclaimed",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-alert-runner-timeout",
      max: 3,
    });
    const revision = String(randomInt(6_000_000_000, 7_000_000_000));
    let ids: string[] = [];
    let resolveLate: (() => void) | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      ids = await seed(pool, revision, ["OLDEST_DUE"]);
      await assert.rejects(
        superviseOutboxAlertDelivery(
          pool,
          async () =>
            new Promise<void>((resolve) => {
              resolveLate = resolve;
            }),
          {
            signal: new AbortController().signal,
            leaseMs: 500,
            handlerTimeoutMs: 30,
          },
        ),
        /Outbox alert runner stopped after abandoned lease/,
      );

      const stale = await pool.query<{
        status: string;
        attempts: number;
        lease_token: string;
      }>(
        `SELECT status, attempts, lease_token::text
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [ids[0]],
      );
      assert.equal(stale.rows[0]?.status, "leased");
      assert.equal(stale.rows[0]?.attempts, 1);
      await pool.query(
        `UPDATE cookie_jobs.outbox_alert_delivery
            SET lease_until=clock_timestamp()-interval '1 second'
          WHERE transition_id=$1::bigint`,
        [ids[0]],
      );

      const recovered = await claimOutboxAlertDeliveries(pool, {
        batchSize: 1,
        leaseMs: 1_000,
      });
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.transitionId, ids[0]);
      assert.equal(recovered[0]?.attempts, 2);
      assert.notEqual(recovered[0]?.leaseToken, stale.rows[0]?.lease_token);
      assert.equal(
        await acknowledgeOutboxAlertDelivery(pool, recovered[0]!),
        true,
      );
      resolveLate?.();
      await Promise.resolve();
      const final = await pool.query<{ status: string; attempts: number }>(
        `SELECT status, attempts
           FROM cookie_jobs.outbox_alert_delivery
          WHERE transition_id=$1::bigint`,
        [ids[0]],
      );
      assert.deepEqual(final.rows[0], { status: "delivered", attempts: 2 });
    } finally {
      resolveLate?.();
      try {
        await cleanup(pool, ids);
      } finally {
        await pool.end();
      }
    }
  },
);
