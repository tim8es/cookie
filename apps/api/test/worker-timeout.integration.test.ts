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
} from "../../../packages/platform-db/src/outbox.js";
import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

test(
  "bounded Outbox handler timeout abandons lease without ACK, then a new fenced worker can reclaim it",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-worker-timeout-qa",
      max: 3,
    });
    const owner = randomUUID();
    const tenantId = randomUUID();
    let oldToken = "";
    let eventId = "";
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
         VALUES($1::uuid, $2::uuid, 'Synthetic bounded worker')`,
        [tenantId, owner],
      );
      const connection = await pool.connect();
      try {
        eventId = (
          await enqueueOutbox(connection, {
            tenantId,
            dedupeKey: "bounded-worker-timeout",
            topic: "test.synthetic",
            payload: { synthetic: true },
            maxAttempts: 2,
          })
        ).id;
      } finally {
        connection.release();
      }

      let calls = 0;
      let aborted = false;
      const observations: unknown[] = [];
      await assert.rejects(
        runTrustedPostgresOutboxWorker(
          pool,
          async (lease, signal) => {
            calls++;
            assert.equal(lease.id, eventId);
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true },
            );
            await new Promise<void>(() => {});
          },
          {
            signal: new AbortController().signal,
            topic: "test.synthetic",
            leaseMs: 500,
            handlerTimeoutMs: 40,
            idleDelayMs: 10,
            busyDelayMs: 10,
            observe: (sample) => observations.push(sample),
          },
        ),
        /Outbox supervisor stopped after abandoned lease/,
      );
      assert.equal(calls, 1, "a timed-out worker must not start another task");
      assert.equal(aborted, true);
      assert.doesNotMatch(
        JSON.stringify(observations),
        /synthetic|tenant|token|payload/,
      );

      const leased = await pool.query<{
        status: string;
        lease_token: string;
        attempts: number;
      }>(
        `SELECT status, lease_token::text, attempts
           FROM cookie_jobs.outbox_events WHERE id=$1::uuid`,
        [eventId],
      );
      assert.equal(leased.rows[0]?.status, "leased");
      assert.equal(leased.rows[0]?.attempts, 1);
      oldToken = leased.rows[0]?.lease_token ?? "";
      assert.ok(oldToken);

      await new Promise<void>((resolve) => setTimeout(resolve, 570));
      const recovery = await claimOutbox(pool, {
        topic: "test.synthetic",
        batchSize: 1,
        leaseMs: 2_000,
      });
      assert.equal(recovery.length, 1);
      assert.equal(recovery[0]?.id, eventId);
      assert.equal(recovery[0]?.attempts, 2);
      assert.notEqual(recovery[0]?.leaseToken, oldToken);
      assert.equal(
        await acknowledgeOutbox(pool, { id: eventId, leaseToken: oldToken }),
        false,
      );
      assert.equal(await acknowledgeOutbox(pool, recovery[0]!), true);
      const delivered = await pool.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [eventId],
      );
      assert.equal(delivered.rows[0]?.status, "delivered");
      assert.equal(delivered.rows[0]?.attempts, 2);
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

test(
  "bounded handler success is acknowledged even when graceful shutdown is requested in-flight",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-worker-success-timeout-qa",
      max: 2,
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
         VALUES($1::uuid, $2::uuid, 'Synthetic graceful worker')`,
        [tenantId, owner],
      );
      const client = await pool.connect();
      try {
        eventId = (
          await enqueueOutbox(client, {
            tenantId,
            dedupeKey: "bounded-worker-success",
            topic: "test.synthetic",
            payload: { synthetic: true },
          })
        ).id;
      } finally {
        client.release();
      }
      const shutdown = new AbortController();
      const result = await runTrustedPostgresOutboxWorker(
        pool,
        async (lease) => {
          assert.equal(lease.id, eventId);
          shutdown.abort();
        },
        {
          signal: shutdown.signal,
          topic: "test.synthetic",
          leaseMs: 1_000,
          handlerTimeoutMs: 400,
          idleDelayMs: 10,
          busyDelayMs: 10,
        },
      );
      assert.deepEqual(result, {
        claimed: 1,
        delivered: 1,
        failed: 0,
        stale: 0,
      });
      const after = await pool.query<{ status: string }>(
        "SELECT status FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [eventId],
      );
      assert.equal(after.rows[0]?.status, "delivered");
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
