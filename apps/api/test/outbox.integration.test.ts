import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  acknowledgeOutbox,
  claimOutbox,
  enqueueOutbox,
  failOutbox,
  retryDelayMs,
  runOutboxBatch,
} from "../../../packages/platform-db/src/outbox.js";

test(
  "outbox uses committed transactions, dedupe, leases, retries and dead letters in PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-outbox-integration",
      max: 6,
    });
    const owner = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const topic = "booking.confirmed";
    const payload = { bookingId: "synthetic-1", revision: 1 };
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
         VALUES($1::uuid,$3::uuid,'Synthetic outbox A'),($2::uuid,$3::uuid,'Synthetic outbox B')`,
        [tenantA, tenantB, owner],
      );

      const client = await pool.connect();
      let firstId: string;
      try {
        await client.query("BEGIN");
        const rolledBack = await enqueueOutbox(client, {
          tenantId: tenantA,
          dedupeKey: "rollback-1",
          topic,
          payload,
        });
        await client.query("ROLLBACK");
        const absent = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
          [rolledBack.id],
        );
        assert.equal(absent.rows[0]?.count, "0");

        await client.query("BEGIN");
        const first = await enqueueOutbox(client, {
          tenantId: tenantA,
          dedupeKey: "stable-1",
          topic,
          payload,
        });
        assert.equal(first.inserted, true);
        const duplicate = await enqueueOutbox(client, {
          tenantId: tenantA,
          dedupeKey: "stable-1",
          topic,
          payload: { revision: 1, bookingId: "synthetic-1" },
        });
        assert.deepEqual(duplicate, { id: first.id, inserted: false });
        await assert.rejects(
          enqueueOutbox(client, {
            tenantId: tenantA,
            dedupeKey: "stable-1",
            topic,
            payload: { bookingId: "synthetic-different" },
          }),
          /idempotency key reused/,
        );
        await client.query("COMMIT");
        firstId = first.id;

        const secondTenant = await enqueueOutbox(client, {
          tenantId: tenantB,
          dedupeKey: "stable-1",
          topic,
          payload,
        });
        assert.equal(secondTenant.inserted, true);
        assert.notEqual(secondTenant.id, firstId);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }

      // Claims are atomic across multiple worker processes and tenant IDs.
      for (let i = 0; i < 6; i++) {
        const producer = await pool.connect();
        try {
          await enqueueOutbox(producer, {
            tenantId: tenantA,
            dedupeKey: "parallel-" + i,
            topic,
            payload: { index: i },
          });
        } finally {
          producer.release();
        }
      }
      const [firstClaim, secondClaim] = await Promise.all([
        claimOutbox(pool, { batchSize: 4, leaseMs: 60_000 }),
        claimOutbox(pool, { batchSize: 4, leaseMs: 60_000 }),
      ]);
      const claimed = [...firstClaim, ...secondClaim];
      assert.equal(claimed.length, 8);
      assert.equal(new Set(claimed.map((job) => job.id)).size, 8);
      assert.equal(claimed.every((job) => job.attempts === 1), true);
      const selected = claimed.find((job) => job.id === firstId);
      assert.ok(selected, "committed event must become claimable");
      assert.equal(
        await acknowledgeOutbox(pool, { ...selected, leaseToken: randomUUID() }),
        false,
      );

      // Stale worker cannot acknowledge after lease expiry or re-claim.
      await pool.query(
        "UPDATE cookie_jobs.outbox_events SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1::uuid",
        [selected.id],
      );
      const recovered = await claimOutbox(pool, { batchSize: 1, leaseMs: 60_000 });
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.id, selected.id);
      assert.equal(recovered[0]?.attempts, 2);
      assert.notEqual(recovered[0]?.leaseToken, selected.leaseToken);
      assert.equal(await acknowledgeOutbox(pool, selected), false);
      assert.equal(await acknowledgeOutbox(pool, recovered[0]!), true);
      assert.equal(await acknowledgeOutbox(pool, recovered[0]!), false);

      // Clear remaining leased events so isolated retry cases are deterministic.
      await pool.query("DELETE FROM cookie_jobs.outbox_events WHERE tenant_id = ANY($1::uuid[]) AND status <> 'delivered'", [[tenantA, tenantB]]);

      const p = await pool.connect();
      let retryId = "";
      try {
        const result = await enqueueOutbox(p, {
          tenantId: tenantA,
          dedupeKey: "retry-final",
          topic,
          payload,
          maxAttempts: 2,
        });
        retryId = result.id;
      } finally {
        p.release();
      }
      const firstRetry = await claimOutbox(pool, { batchSize: 1 });
      assert.equal(firstRetry[0]?.id, retryId);
      assert.equal(await failOutbox(pool, firstRetry[0]!, "DELIVERY_FAILED", 0), true);
      const secondRetry = await claimOutbox(pool, { batchSize: 1 });
      assert.equal(secondRetry[0]?.id, retryId);
      assert.equal(secondRetry[0]?.attempts, 2);
      assert.equal(await failOutbox(pool, secondRetry[0]!, "DELIVERY_FAILED", 0), true);
      const dead = await pool.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [retryId],
      );
      assert.deepEqual(dead.rows[0], { status: "dead", attempts: 2 });
      assert.deepEqual(await claimOutbox(pool, { batchSize: 1 }), []);

      // If final-attempt worker crashed, its expired lease becomes dead too.
      const crashed = await pool.connect();
      let crashedId = "";
      try {
        crashedId = (
          await enqueueOutbox(crashed, {
            tenantId: tenantA,
            dedupeKey: "last-crash",
            topic,
            payload,
            maxAttempts: 1,
          })
        ).id;
      } finally {
        crashed.release();
      }
      const lastLease = await claimOutbox(pool, { batchSize: 1 });
      assert.equal(lastLease[0]?.id, crashedId);
      await pool.query(
        "UPDATE cookie_jobs.outbox_events SET lease_until = clock_timestamp() - interval '1 second' WHERE id=$1::uuid",
        [crashedId],
      );
      assert.deepEqual(await claimOutbox(pool, { batchSize: 1 }), []);
      assert.equal(
        (
          await pool.query<{ status: string }>(
            "SELECT status FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
            [crashedId],
          )
        ).rows[0]?.status,
        "dead",
      );

      const runnerClient = await pool.connect();
      let runnerId = "";
      try {
        runnerId = (
          await enqueueOutbox(runnerClient, {
            tenantId: tenantA,
            dedupeKey: "worker-runner",
            topic,
            payload: { bookingId: "synthetic-runner" },
          })
        ).id;
      } finally {
        runnerClient.release();
      }
      const failure = await runOutboxBatch(
        pool,
        async () => { throw new Error("fake external token=never-store"); },
        { batchSize: 1 },
      );
      assert.deepEqual(failure, { claimed: 1, delivered: 0, failed: 1, stale: 0 });
      const persisted = await pool.query<{
        status: string;
        last_failure_code: string;
        available_at: Date;
      }>(
        "SELECT status, last_failure_code, available_at FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [runnerId],
      );
      assert.equal(persisted.rows[0]?.status, "pending");
      assert.equal(persisted.rows[0]?.last_failure_code, "DELIVERY_FAILED");
      assert.ok(persisted.rows[0]?.available_at.getTime() > Date.now() - 1_000);
      await pool.query(
        "UPDATE cookie_jobs.outbox_events SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
        [runnerId],
      );
      const received: string[] = [];
      const success = await runOutboxBatch(
        pool,
        async (event) => { received.push(event.id); },
        { batchSize: 1 },
      );
      assert.deepEqual(success, { claimed: 1, delivered: 1, failed: 0, stale: 0 });
      assert.deepEqual(received, [runnerId]);
      assert.equal(retryDelayMs(1, () => 0), 750);
      assert.equal(retryDelayMs(1, () => 0.5), 1_000);
      assert.equal(retryDelayMs(12, () => 0), 45_000);

      const final = await pool.query<{ delivered: string; dead: string }>(
        `SELECT
          count(*) FILTER (WHERE status='delivered')::text AS delivered,
          count(*) FILTER (WHERE status='dead')::text AS dead
          FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid`,
        [tenantA],
      );
      assert.equal(final.rows[0]?.delivered, "2");
      assert.equal(final.rows[0]?.dead, "2");
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id = ANY($1::uuid[])",
          [[tenantA, tenantB]],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id = ANY($1::uuid[])",
          [[tenantA, tenantB]],
        );
        await pool.query("DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [owner]);
      } finally {
        await pool.end();
      }
    }
  },
);
