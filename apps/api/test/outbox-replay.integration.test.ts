import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  claimOutbox,
  enqueueOutbox,
  failOutbox,
} from "../../../packages/platform-db/src/outbox.js";
import { replayDeadOutbox } from "../../../packages/platform-db/src/replay.js";
import type { TrustedActor } from "../../../packages/platform-identity/src/authorization.js";

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
      assert.deepEqual(
        await replayDeadOutbox(pool, { actor, eventId: deadId }),
        { requeued: true, replayCount: 1 },
      );
      assert.deepEqual(
        await replayDeadOutbox(pool, { actor, eventId: deadId }),
        { requeued: false, replayCount: 1 },
        "a pending event cannot be replayed twice",
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

      for (const replayCount of [2, 3]) {
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
