import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { enqueueOutbox } from "../../../packages/platform-db/src/outbox.js";
import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

test(
  "an expired Outbox lease cannot start a handler after a delayed PostgreSQL claim result",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-outbox-stale-claim",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const ownerId = randomUUID();
    const tenantId = randomUUID();
    let eventId = "";
    let releaseClaim!: () => void;
    const claimReleased = new Promise<void>((done) => {
      releaseClaim = done;
    });
    let signalClaim!: () => void;
    const claimCommitted = new Promise<void>((done) => {
      signalClaim = done;
    });
    const shutdown = new AbortController();
    let supervisor: Promise<unknown> | undefined;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [ownerId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1::uuid,$2::uuid,'Synthetic stale Outbox claim QA')`,
        [tenantId, ownerId],
      );
      const writer = await pool.connect();
      try {
        eventId = (
          await enqueueOutbox(writer, {
            tenantId,
            dedupeKey: "stale-claim-handling",
            topic: "test.synthetic",
            payload: { synthetic: true },
          })
        ).id;
      } finally {
        writer.release();
      }

      let intercepted = false;
      const delayedResultPool = {
        async query(sql: string, params?: unknown[]) {
          const result = await pool.query(sql, params);
          if (
            !intercepted &&
            sql.includes("WITH chosen AS (") &&
            sql.includes("UPDATE cookie_jobs.outbox_events AS event")
          ) {
            intercepted = true;
            assert.equal(result.rows.length, 1);
            // The PostgreSQL claim has committed and returned to the adapter.
            // Hold only the adapter's delivery of that result, not a DB lock.
            signalClaim();
            await claimReleased;
          }
          return result;
        },
      } as unknown as Pool;

      let handlerStarts = 0;
      // A safe implementation can reject an already-expired lease, but must
      // never start an external handler on it. Capture both outcomes.
      supervisor = runTrustedPostgresOutboxWorker(
        delayedResultPool,
        async () => {
          handlerStarts++;
          shutdown.abort();
        },
        {
          signal: shutdown.signal,
          topic: "test.synthetic",
          leaseMs: 5_000,
          handlerTimeoutMs: 1_000,
          idleDelayMs: 10,
          busyDelayMs: 10,
        },
      ).then(
        () => ({ completed: true }),
        (error: unknown) => ({ completed: false, error }),
      );

      const claimWasReached = await Promise.race([
        claimCommitted.then(() => true),
        supervisor.then(() => false),
      ]);
      assert.equal(
        claimWasReached,
        true,
        "worker must reach a real committed PostgreSQL claim",
      );
      const leased = await pool.query<{ status: string; attempts: number }>(
        `SELECT status,attempts FROM cookie_jobs.outbox_events
          WHERE id=$1::uuid`,
        [eventId],
      );
      assert.equal(leased.rows[0]?.status, "leased");
      assert.equal(leased.rows[0]?.attempts, 1);

      // Deterministic interleaving: expire the real lease while the adapter
      // is paused AFTER PostgreSQL has committed the claim. No sleep/jitter.
      const expired = await pool.query(
        `UPDATE cookie_jobs.outbox_events
            SET lease_until=clock_timestamp()-interval '1 second'
          WHERE id=$1::uuid AND status='leased'
          RETURNING id`,
        [eventId],
      );
      assert.equal(expired.rowCount, 1);
      releaseClaim();
      await supervisor;
      assert.equal(
        handlerStarts,
        0,
        "expired claim must never start a possibly duplicate external send",
      );
    } finally {
      releaseClaim();
      shutdown.abort();
      await supervisor?.catch(() => undefined);
      try {
        await pool
          .query(
            "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid",
            [tenantId],
          )
          .catch(() => undefined);
        await pool
          .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [
            tenantId,
          ])
          .catch(() => undefined);
        await pool
          .query("DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [
            ownerId,
          ])
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
