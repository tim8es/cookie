import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { enqueueOutbox } from "../../../packages/platform-db/src/outbox.js";
import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

test(
  "a valid Outbox handler starts while its PostgreSQL lease row remains locked",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-outbox-handler-start-lock",
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    const identityId = randomUUID();
    const tenantId = randomUUID();
    let eventId = "";
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((done) => {
      releaseCommit = done;
    });
    let signalCommitReached!: () => void;
    const commitReached = new Promise<void>((done) => {
      signalCommitReached = done;
    });
    let signalHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((done) => {
      signalHandlerStarted = done;
    });
    const shutdown = new AbortController();
    let supervisor: Promise<{ completed: boolean }> | undefined;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES($1::uuid,$2::uuid,'Synthetic dispatch lock proof')",
        [tenantId, identityId],
      );

      const writer = await pool.connect();
      try {
        eventId = (
          await enqueueOutbox(writer, {
            tenantId,
            dedupeKey: "qa-handler-start-row-lock",
            topic: "qa.handlerlock",
            payload: { synthetic: true },
          })
        ).id;
      } finally {
        writer.release();
      }

      let commitIntercepted = false;
      let guardedConnections = 0;
      // Use a REAL PoolClient; only withhold its COMMIT invocation after
      // the handler has been synchronously invoked under FOR UPDATE.
      const gatedPool = {
        query(sql: string, params?: unknown[]) {
          return pool.query(sql, params);
        },
        async connect() {
          guardedConnections++;
          const client = await pool.connect();
          return {
            async query(sql: string, params?: unknown[]) {
              if (sql === "COMMIT" && !commitIntercepted) {
                commitIntercepted = true;
                signalCommitReached();
                await commitReleased;
              }
              return client.query(sql, params);
            },
            release() {
              client.release();
            },
          };
        },
      } as unknown as Pool;

      let handlerStarts = 0;
      supervisor = runTrustedPostgresOutboxWorker(
        gatedPool,
        async () => {
          handlerStarts++;
          signalHandlerStarted();
          shutdown.abort();
        },
        {
          signal: shutdown.signal,
          topic: "qa.handlerlock",
          leaseMs: 9_000,
          handlerTimeoutMs: 2_000,
          idleDelayMs: 10,
          busyDelayMs: 10,
        },
      ).then(
        () => ({ completed: true }),
        (error: unknown) => ({ completed: false, error }),
      );

      assert.equal(
        await Promise.race([
          Promise.all([handlerStarted, commitReached]).then(() => true),
          supervisor.then(() => false),
        ]),
        true,
        "handler must start synchronously before the guarded transaction COMMIT",
      );

      // The separate PostgreSQL session must NOT be allowed to mutate this
      // same event while its valid handler is starting, even with a fresh
      // application query. A short lock_timeout tests the held lock, not
      // scheduler timing or a fixed sleep.
      const rival = await pool.connect();
      try {
        await rival.query("BEGIN");
        await rival.query("SET LOCAL lock_timeout = '250ms'");
        await assert.rejects(
          rival.query(
            "UPDATE cookie_jobs.outbox_events SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid RETURNING id",
            [eventId],
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "55P03",
          "competing lease mutation must fail with PostgreSQL lock_not_available (55P03)",
        );
        await rival.query("ROLLBACK");
      } finally {
        await rival.query("ROLLBACK").catch(() => undefined);
        rival.release();
      }

      releaseCommit();
      const finished = await supervisor;
      assert.equal(
        finished.completed,
        true,
        "guarded worker must finish normally",
      );
      assert.equal(
        handlerStarts,
        1,
        "valid event must be handled exactly once",
      );
      assert.equal(
        guardedConnections,
        1,
        "one real transactional dispatch guard",
      );
      const state = await pool.query<{ status: string; attempts: number }>(
        "SELECT status,attempts FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [eventId],
      );
      assert.deepEqual(state.rows[0], { status: "delivered", attempts: 1 });
    } finally {
      releaseCommit();
      shutdown.abort();
      await supervisor?.catch(() => undefined);
      try {
        await pool
          .query(
            "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid",
            [tenantId],
          )
          .catch(() => undefined);
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenantId],
        ).catch(() => undefined);
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [identityId],
        ).catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
