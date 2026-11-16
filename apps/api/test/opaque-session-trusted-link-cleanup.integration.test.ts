import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { PostgresOpaqueSessionMaintenance } from "../../../packages/platform-identity/src/opaque-session-maintenance.js";

test(
  "trusted Telegram link blocks disabled membership deletion until expired linked sessions are purged",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-opaque-link-fk-order",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const linkId = randomUUID();
    const tokenHash = randomBytes(32);
    const maintenance = new PostgresOpaqueSessionMaintenance({
      pool,
      retentionSeconds: 7_200,
      batchSize: 1,
    });

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id, owner_identity_id, display_name)
         VALUES ($1::uuid, $2::uuid, 'Synthetic link retention tenant')`,
        [tenantId, identityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenantId, identityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.telegram_identity_links
           (tenant_id,id,identity_id,telegram_user_hmac_sha256,
            proof_verified_at,consent_confirmed_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::bytea,
                 clock_timestamp(),clock_timestamp())`,
        [tenantId, linkId, identityId, randomBytes(32)],
      );
      await pool.query(
        `INSERT INTO cookie_identity.opaque_sessions
           (token_sha256,telegram_exchange_sha256,tenant_id,identity_id,
            issuer,audience,issued_at,expires_at,telegram_link_id)
         VALUES ($1::bytea,$2::bytea,$3::uuid,$4::uuid,
                 'synthetic','booking',
                 clock_timestamp()-interval '4 hours',
                 clock_timestamp()-interval '3 hours',$5::uuid)`,
        [tokenHash, randomBytes(32), tenantId, identityId, linkId],
      );

      // Membership-disable revokes the bearer but does not implicitly
      // delete replay-proof hashes or the trusted Identity link.
      await pool.query(
        `UPDATE cookie_identity.memberships SET active=false
          WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenantId, identityId],
      );
      const session = await pool.query<{
        revoked: boolean;
        telegram_link_id: string;
      }>(
        `SELECT revoked_at IS NOT NULL AS revoked,
                telegram_link_id::text AS telegram_link_id
           FROM cookie_identity.opaque_sessions
          WHERE token_sha256=$1::bytea`,
        [tokenHash],
      );
      assert.equal(session.rows[0]?.revoked, true);
      assert.equal(session.rows[0]?.telegram_link_id, linkId);

      // The member delete tries to remove a batch of eligible sessions
      // then hits the link's RESTRICT FK. Entire transaction rolls back.
      assert.deepEqual(
        await maintenance.deleteInactiveMembership(tenantId, identityId),
        { status: "blocked-by-dependencies", deletedSessions: 0 },
      );
      assert.equal(
        (
          await pool.query(
            `SELECT 1 FROM cookie_identity.opaque_sessions
              WHERE token_sha256=$1::bytea`,
            [tokenHash],
          )
        ).rowCount,
        1,
        "FK failure must restore even an expired session deleted in the transaction",
      );
      assert.equal(
        (
          await pool.query(
            `SELECT 1 FROM cookie_identity.memberships
              WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
                AND active=false`,
            [tenantId, identityId],
          )
        ).rowCount,
        1,
      );

      // Link deletion while the exact composite session FK exists is
      // forbidden; there is deliberately no automatic CASCADE.
      await assert.rejects(
        pool.query(
          `DELETE FROM cookie_identity.telegram_identity_links
            WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [tenantId, linkId],
        ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "23503");
          return true;
        },
      );
      assert.equal(
        (
          await pool.query(
            `SELECT 1 FROM cookie_identity.telegram_identity_links
              WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            [tenantId, linkId],
          )
        ).rowCount,
        1,
      );

      // Only the internal owner-controlled sequence is permitted:
      // eligible session purge, explicit link deletion, membership removal.
      assert.deepEqual(await maintenance.purgeBatch(), { deleted: 1 });
      assert.equal(
        (
          await pool.query(
            `DELETE FROM cookie_identity.telegram_identity_links
              WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            [tenantId, linkId],
          )
        ).rowCount,
        1,
      );
      assert.deepEqual(
        await maintenance.deleteInactiveMembership(tenantId, identityId),
        { status: "deleted", deletedSessions: 0 },
      );
      assert.equal(
        (
          await pool.query(
            `SELECT 1 FROM cookie_identity.memberships
              WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
            [tenantId, identityId],
          )
        ).rowCount,
        0,
      );
    } finally {
      try {
        await pool
          .query(
            "DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1::uuid",
            [tenantId],
          )
          .catch(() => undefined);
        await pool
          .query(
            "DELETE FROM cookie_identity.telegram_identity_links WHERE tenant_id=$1::uuid",
            [tenantId],
          )
          .catch(() => undefined);
        await pool
          .query(
            "DELETE FROM cookie_identity.memberships WHERE tenant_id=$1::uuid",
            [tenantId],
          )
          .catch(() => undefined);
        await pool
          .query(
            "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
            [tenantId],
          )
          .catch(() => undefined);
        await pool
          .query(
            "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
            [identityId],
          )
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
