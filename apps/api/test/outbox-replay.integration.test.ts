import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  claimOutbox,
  enqueueOutbox,
  failOutbox,
} from "../../../packages/platform-db/src/outbox.js";
import { replayDeadOutbox } from "../../../packages/platform-db/src/replay.js";
import type { TrustedActor } from "../../../packages/platform-identity/src/authorization.js";

/** Test-only facade around a real PostgreSQL connection. */
function faultAtCommit(realPool: Pool, mode: "abort" | "lose-ack") {
  const releases: boolean[] = [];
  const commands: string[] = [];
  let commitTag: string | undefined;
  let isolation: string | undefined;
  const pool = {
    async connect(): Promise<PoolClient> {
      const physical = await realPool.connect();
      return {
        async query(sql: string, params?: unknown[]): Promise<unknown> {
          commands.push(sql);
          if (sql === "COMMIT") {
            const setting = await physical.query<{
              transaction_isolation: string;
            }>("SHOW transaction_isolation");
            isolation = setting.rows[0]?.transaction_isolation;
            if (mode === "abort") {
              await assert.rejects(physical.query("SELECT 1 / 0"), {
                code: "22012",
              });
            }
            const result = await physical.query(sql);
            commitTag = result.command;
            if (mode === "lose-ack") {
              throw new Error("SYNTHETIC_COMMIT_ACK_LOST");
            }
            return result;
          }
          return physical.query(sql, params);
        },
        release(discard: boolean): void {
          releases.push(discard);
          physical.release(discard);
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return {
    pool,
    assertDiscarded(): void {
      assert.equal(isolation, "serializable");
      assert.equal(commitTag, mode === "abort" ? "ROLLBACK" : "COMMIT");
      assert.deepEqual(releases, [true]);
      assert.equal(commands.filter((sql) => sql === "COMMIT").length, 1);
      assert.equal(commands.includes("ROLLBACK"), false);
    },
  };
}

test(
  "dead-letter replay requires actual Owner permission, is audited and bounded",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-replay-integration",
      max: 5,
    });
    const owner = randomUUID();
    const admin = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const ownerRole = randomUUID();
    const fakeOwnerRole = randomUUID();
    const ownerAssignment = randomUUID();
    const adminAssignment = randomUUID();
    const actor: TrustedActor = {
      identityId: owner,
      tenantId: tenantA,
      correlationId: "synthetic-replay-test",
    };
    let deadId = "";
    let foreignId = "";
    let nonTestId = "";
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid)",
        [owner, admin],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'Synthetic replay A'),($2::uuid,$3::uuid,'Synthetic replay B')`,
        [tenantA, tenantB, owner],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid)`,
        [tenantA, owner, admin],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES ($1::uuid,$2::uuid,'owner','Organization owner',ARRAY['outbox.replay']),
                ($1::uuid,$3::uuid,'admin','Owner',ARRAY['outbox.replay'])`,
        [tenantA, ownerRole, fakeOwnerRole],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id,location_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,NULL),
                ($1::uuid,$5::uuid,$6::uuid,$7::uuid,NULL)`,
        [
          tenantA,
          ownerAssignment,
          owner,
          ownerRole,
          adminAssignment,
          admin,
          fakeOwnerRole,
        ],
      );

      const producer = await pool.connect();
      try {
        deadId = (
          await enqueueOutbox(producer, {
            tenantId: tenantA,
            dedupeKey: "synthetic-replay-dead",
            topic: "test.synthetic",
            payload: { synthetic: true },
            maxAttempts: 1,
          })
        ).id;
        foreignId = (
          await enqueueOutbox(producer, {
            tenantId: tenantB,
            dedupeKey: "synthetic-replay-foreign",
            topic: "booking.confirmed",
            payload: { synthetic: true },
          })
        ).id;
        nonTestId = (
          await enqueueOutbox(producer, {
            tenantId: tenantA,
            dedupeKey: "synthetic-replay-not-a-test",
            topic: "booking.confirmed",
            payload: { synthetic: true },
          })
        ).id;
      } finally {
        producer.release();
      }

      async function exhaust(): Promise<void> {
        const claims = await claimOutbox(pool, {
          batchSize: 1,
          topic: "test.synthetic",
        });
        assert.equal(claims.length, 1);
        assert.equal(claims[0]?.id, deadId);
        assert.equal(
          await failOutbox(pool, claims[0]!, "SYNTHETIC_FAILURE", 0),
          true,
        );
      }

      await exhaust();
      assert.deepEqual(
        await claimOutbox(pool, { topic: "test.synthetic" }),
        [],
      );

      await assert.rejects(
        replayDeadOutbox(pool, {
          actor: { ...actor, identityId: admin },
          eventId: deadId,
        }),
        /Outbox dead-letter replay refused/,
        "a role named Owner must never confer nondelegable access",
      );
      await assert.rejects(
        replayDeadOutbox(pool, {
          actor: { ...actor, tenantId: tenantB },
          eventId: deadId,
        }),
        /Outbox dead-letter replay refused/,
        "a foreign tenant has no local owner membership",
      );
      assert.deepEqual(
        await replayDeadOutbox(pool, { actor, eventId: foreignId }),
        { requeued: false, replayCount: null },
        "a cross-tenant event must never be visible or replayed",
      );
      async function snapshot() {
        const result = await pool.query(
          `SELECT to_jsonb(e) AS event,
                  (SELECT count(*)::text FROM cookie_jobs.outbox_replay_audit
                   WHERE event_id=e.id) AS replays,
                  (SELECT count(*)::text FROM cookie_identity.authorization_audit
                   WHERE tenant_id=e.tenant_id) AS authorizations
             FROM cookie_jobs.outbox_events e WHERE id=$1::uuid`,
          [deadId],
        );
        assert.ok(result.rows[0]);
        return result.rows[0];
      }

      async function expectCommitFailure(mode: "abort" | "lose-ack") {
        const fault = faultAtCommit(pool, mode);
        await assert.rejects(
          replayDeadOutbox(fault.pool, { actor, eventId: deadId }),
          /^Error: Outbox dead-letter replay refused$/,
        );
        fault.assertDiscarded();
      }

      // Real PostgreSQL returns ROLLBACK on COMMIT after a late SQL error.
      // The command must not report a replay or persist either audit.
      const beforeAbort = await snapshot();
      await expectCommitFailure("abort");
      assert.deepEqual(await snapshot(), beforeAbort);

      assert.deepEqual(
        await replayDeadOutbox(pool, { actor, eventId: deadId }),
        { requeued: true, replayCount: 1 },
      );
      assert.deepEqual(
        await replayDeadOutbox(pool, { actor, eventId: deadId }),
        { requeued: false, replayCount: 1 },
        "a pending event cannot be replayed twice",
      );

      const beforeNoop = await snapshot();
      await expectCommitFailure("abort");
      assert.deepEqual(await snapshot(), beforeNoop);
      await expectCommitFailure("lose-ack");
      const afterNoop = await snapshot();
      assert.deepEqual(afterNoop.event, beforeNoop.event);
      assert.equal(afterNoop.replays, beforeNoop.replays);
      assert.equal(
        Number(afterNoop.authorizations),
        Number(beforeNoop.authorizations) + 1,
      );

      let row = await pool.query<{
        status: string;
        attempts: number;
        manual_replay_count: number;
      }>(
        "SELECT status, attempts, manual_replay_count FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [deadId],
      );
      assert.deepEqual(row.rows[0], {
        status: "pending",
        attempts: 0,
        manual_replay_count: 1,
      });

      // The actual commit succeeded, but the acknowledgement was lost.
      // Do not return success, retry automatically, or duplicate the replay.
      await exhaust();
      const beforeLost = await snapshot();
      await expectCommitFailure("lose-ack");
      const afterLost = await snapshot();
      assert.equal(Number(afterLost.replays), Number(beforeLost.replays) + 1);
      assert.equal(
        Number(afterLost.authorizations),
        Number(beforeLost.authorizations) + 1,
      );
      assert.deepEqual(
        await replayDeadOutbox(pool, { actor, eventId: deadId }),
        { requeued: false, replayCount: 2 },
      );

      for (const replayCount of [3]) {
        await exhaust();
        assert.deepEqual(
          await replayDeadOutbox(pool, { actor, eventId: deadId }),
          { requeued: true, replayCount },
        );
      }
      await exhaust();
      assert.deepEqual(
        await replayDeadOutbox(pool, { actor, eventId: deadId }),
        { requeued: false, replayCount: 3 },
        "a fourth manual replay requires a new explicit policy, not endless retries",
      );

      const audit = await pool.query<{
        replay_number: number;
        previous_attempts: number;
        actor_identity_id: string;
        event_id: string;
      }>(
        `SELECT replay_number, previous_attempts,
                actor_identity_id::text, event_id::text
           FROM cookie_jobs.outbox_replay_audit WHERE event_id=$1::uuid
           ORDER BY replay_number`,
        [deadId],
      );
      assert.deepEqual(
        audit.rows.map((item) => item.replay_number),
        [1, 2, 3],
      );
      assert.equal(
        audit.rows.every((item) => item.previous_attempts === 1),
        true,
      );
      assert.equal(
        audit.rows.every((item) => item.actor_identity_id === owner),
        true,
      );
      assert.equal(
        audit.rows.every((item) => item.event_id === deadId),
        true,
      );

      const unmodified = await pool.query<{
        id: string;
        status: string;
        manual_replay_count: number;
      }>(
        `SELECT id::text, status, manual_replay_count
          FROM cookie_jobs.outbox_events
          WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[foreignId, nonTestId]],
      );
      assert.equal(unmodified.rows.length, 2);
      assert.equal(
        unmodified.rows.every((r) => r.status === "pending"),
        true,
      );
      assert.equal(
        unmodified.rows.every((r) => r.manual_replay_count === 0),
        true,
      );

      row = await pool.query(
        "SELECT status, attempts, manual_replay_count FROM cookie_jobs.outbox_events WHERE id=$1::uuid",
        [deadId],
      );
      assert.deepEqual(row.rows[0], {
        status: "dead",
        attempts: 1,
        manual_replay_count: 3,
      });
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_replay_audit WHERE tenant_id=$1::uuid",
          [tenantA],
        );
        await pool.query(
          "DELETE FROM cookie_identity.authorization_audit WHERE tenant_id=$1::uuid",
          [tenantA],
        );
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=ANY($1::uuid[])",
          [[tenantA, tenantB]],
        );
        await pool.query(
          "DELETE FROM cookie_identity.role_assignments WHERE tenant_id=$1::uuid",
          [tenantA],
        );
        await pool.query(
          "DELETE FROM cookie_identity.roles WHERE tenant_id=$1::uuid",
          [tenantA],
        );
        await pool.query(
          "DELETE FROM cookie_identity.memberships WHERE tenant_id=$1::uuid",
          [tenantA],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=ANY($1::uuid[])",
          [[tenantA, tenantB]],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [[owner, admin]],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
