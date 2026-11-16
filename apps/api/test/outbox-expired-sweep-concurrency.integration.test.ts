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

test(
  "locked expired final lease cannot block claim of another ready tenant event",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-outbox-expiry-contention",
      max: 3,
    });
    // A dedicated second connection enforces a deterministic PostgreSQL
    // lock deadline. The pre-fix UPDATE waits and fails at 55P03; SKIP LOCKED
    // must instead claim the independent event without waiting.
    const claimingPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-outbox-expiry-claim",
      options: "-c lock_timeout=300ms",
      max: 2,
    });
    const owner = randomUUID();
    const blockedTenant = randomUUID();
    const readyTenant = randomUUID();
    const topic = "qa.expirysweep";
    let lockHeld = false;
    let unrelatedTopicId = "";
    const locker = await pool.connect();
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
         VALUES ($1::uuid, $3::uuid, 'Synthetic blocked lease'),
                ($2::uuid, $3::uuid, 'Synthetic ready lease')`,
        [blockedTenant, readyTenant, owner],
      );

      const writer = await pool.connect();
      let exhaustedId = "";
      let readyId = "";
      try {
        exhaustedId = (
          await enqueueOutbox(writer, {
            tenantId: blockedTenant,
            dedupeKey: "expired-final",
            topic,
            payload: { synthetic: true },
            maxAttempts: 1,
          })
        ).id;
      } finally {
        writer.release();
      }

      const unrelatedWriter = await pool.connect();
      try {
        unrelatedTopicId = (
          await enqueueOutbox(unrelatedWriter, {
            tenantId: blockedTenant,
            dedupeKey: "expired-other-topic",
            topic: "qa.anothertopic",
            payload: { synthetic: true },
            maxAttempts: 1,
          })
        ).id;
      } finally {
        unrelatedWriter.release();
      }
      const unrelated = await claimOutbox(pool, {
        topic: "qa.anothertopic",
        batchSize: 1,
      });
      assert.equal(unrelated[0]?.id, unrelatedTopicId);
      await pool.query(
        `UPDATE cookie_jobs.outbox_events
         SET lease_until = clock_timestamp() - interval '1 second'
         WHERE id=$1::uuid`,
        [unrelatedTopicId],
      );

      const first = await claimOutbox(pool, { topic, batchSize: 1 });
      assert.equal(first.length, 1);
      assert.equal(first[0]?.id, exhaustedId);
      assert.equal(first[0]?.attempts, 1);
      await pool.query(
        `UPDATE cookie_jobs.outbox_events
         SET lease_until = clock_timestamp() - interval '1 second'
         WHERE id=$1::uuid`,
        [exhaustedId],
      );

      const producer = await pool.connect();
      try {
        readyId = (
          await enqueueOutbox(producer, {
            tenantId: readyTenant,
            dedupeKey: "ready-independent",
            topic,
            payload: { synthetic: true },
            maxAttempts: 2,
          })
        ).id;
      } finally {
        producer.release();
      }

      await locker.query("BEGIN");
      lockHeld = true;
      await locker.query(
        `SELECT id FROM cookie_jobs.outbox_events
         WHERE id=$1::uuid FOR UPDATE`,
        [exhaustedId],
      );

      // Other ready work remains claimable even while the expired row is
      // protected by an unrelated uncommitted transaction.
      const recoveredReady = await claimOutbox(claimingPool, {
        topic,
        batchSize: 1,
        leaseMs: 30_000,
      });
      assert.equal(recoveredReady.length, 1);
      assert.equal(recoveredReady[0]?.id, readyId);
      assert.equal(recoveredReady[0]?.tenantId, readyTenant);
      assert.equal(recoveredReady[0]?.attempts, 1);

      const beforeUnlock = await claimingPool.query<{
        status: string;
        attempts: number;
      }>(
        "SELECT status, attempts FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [exhaustedId],
      );
      assert.deepEqual(beforeUnlock.rows[0], {
        status: "leased",
        attempts: 1,
      });
      assert.equal(
        await acknowledgeOutbox(claimingPool, recoveredReady[0]!),
        true,
      );

      await locker.query("COMMIT");
      lockHeld = false;
      assert.deepEqual(
        await claimOutbox(claimingPool, { topic, batchSize: 1 }),
        [],
      );
      const afterUnlock = await claimingPool.query<{
        status: string;
        last_failure_code: string;
        lease_token: string | null;
        lease_until: Date | null;
      }>(
        `SELECT status, last_failure_code, lease_token::text, lease_until
         FROM cookie_jobs.outbox_events WHERE id=$1::uuid`,
        [exhaustedId],
      );
      assert.deepEqual(afterUnlock.rows[0], {
        status: "dead",
        last_failure_code: "LEASE_EXHAUSTED",
        lease_token: null,
        lease_until: null,
      });
      assert.equal(await acknowledgeOutbox(claimingPool, first[0]!), false);
      const untouchedOtherTopic = await claimingPool.query<{
        status: string;
        attempts: number;
      }>(
        "SELECT status, attempts FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [unrelatedTopicId],
      );
      assert.deepEqual(untouchedOtherTopic.rows[0], {
        status: "leased",
        attempts: 1,
      });
    } finally {
      if (lockHeld) {
        await locker.query("ROLLBACK").catch(() => undefined);
      }
      locker.release();
      try {
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id = ANY($1::uuid[])",
          [[blockedTenant, readyTenant]],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id = ANY($1::uuid[])",
          [[blockedTenant, readyTenant]],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [owner],
        );
      } finally {
        await Promise.all([pool.end(), claimingPool.end()]);
      }
    }
  },
);
