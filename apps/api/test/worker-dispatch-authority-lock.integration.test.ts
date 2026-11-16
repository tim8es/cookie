import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  claimOutbox,
  enqueueOutbox,
} from "../../../packages/platform-db/src/outbox.js";
import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

test(
  "a current-token row-locked dispatch gate rejects stale renewal results",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-outbox-renewal-race",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const ownerId = randomUUID();
    const tenantId = randomUUID();
    let eventId = "";
    let releaseRenewal!: () => void;
    const renewalReleased = new Promise<void>((done) => {
      releaseRenewal = done;
    });
    let signalRenewal!: () => void;
    const renewalCommitted = new Promise<void>((done) => {
      signalRenewal = done;
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
            dedupeKey: "dispatch-lock-result-race",
            topic: "qa.dispatchlock",
            payload: { synthetic: true },
          })
        ).id;
      } finally {
        writer.release();
      }

      let intercepted = false;
      let connected = 0;
      const delayedResultPool = {
        async connect() {
          connected++;
          return pool.connect();
        },
        async query(sql: string, params?: unknown[]) {
          const result = await pool.query(sql, params);
          if (
            !intercepted &&
            sql.includes("SET lease_until=clock_timestamp()") &&
            sql.includes("AND lease_token=$2::uuid")
          ) {
            intercepted = true;
            assert.equal(result.rowCount, 1);
            // A lease renewal has committed, but its response has NOT reached
            // the worker. The DB transaction and row lock are already gone.
            signalRenewal();
            await renewalReleased;
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
          topic: "qa.dispatchlock",
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
        renewalCommitted.then(() => true),
        supervisor.then(() => false),
      ]);
      assert.equal(
        claimWasReached,
        true,
        "worker must reach a real committed PostgreSQL lease renewal",
      );
      const leased = await pool.query<{
        status: string;
        attempts: number;
        lease_token: string;
      }>(
        `SELECT status,attempts,lease_token::text FROM cookie_jobs.outbox_events
          WHERE id=$1::uuid`,
        [eventId],
      );
      assert.equal(leased.rows[0]?.status, "leased");
      assert.equal(leased.rows[0]?.attempts, 1);

      // Expire the renewed lease AFTER COMMIT, before the first worker sees
      // the renewal response. A second worker must be able to reclaim it.
      const expired = await pool.query(
        `UPDATE cookie_jobs.outbox_events
            SET lease_until=clock_timestamp()-interval '1 second'
          WHERE id=$1::uuid AND lease_token=$2::uuid AND status='leased'
          RETURNING id`,
        [eventId, leased.rows[0]?.lease_token],
      );
      assert.equal(expired.rowCount, 1);
      const replacement = await claimOutbox(pool, {
        topic: "qa.dispatchlock",
        batchSize: 1,
        leaseMs: 5_000,
      });
      assert.equal(replacement.length, 1);
      assert.equal(replacement[0]?.id, eventId);
      assert.notEqual(
        replacement[0]?.leaseToken,
        leased.rows[0]?.lease_token,
        "a second worker must own a fresh fencing token",
      );
      releaseRenewal();
      await supervisor;
      assert.equal(
        handlerStarts,
        0,
        "the transactionally fenced first worker cannot dispatch after reclaim",
      );
      assert.equal(
        connected,
        1,
        "worker must acquire a real PostgreSQL connection for dispatch gate",
      );
      const current = await pool.query<{
        status: string;
        attempts: number;
        lease_token: string;
      }>(
        `SELECT status, attempts, lease_token::text
           FROM cookie_jobs.outbox_events WHERE id=$1::uuid`,
        [eventId],
      );
      assert.equal(current.rows[0]?.status, "leased");
      assert.equal(current.rows[0]?.attempts, 2);
      assert.equal(current.rows[0]?.lease_token, replacement[0]?.leaseToken);
    } finally {
      releaseRenewal();
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
