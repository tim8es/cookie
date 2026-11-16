import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";
import { verifyTenantActor } from "../src/session-context.js";

test(
  "Cookie bearer and Telegram unlink revocations serialize with a protected PG transaction",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-session-revocation-lock",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const identityId = randomUUID();
    const tenantId = randomUUID();
    const foreignTenantId = randomUUID();
    const roleId = randomUUID();
    const linkId = randomUUID();
    const token = "cs_" + randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest();
    const expiredToken = "cs_" + randomBytes(32).toString("base64url");
    const expiredHash = createHash("sha256").update(expiredToken).digest();
    const actorVerifier = {
      async verifyBearerToken(value: string) {
        return {
          tenantId,
          identityId,
          expiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 600,
          opaqueSessionAuthority: {
            tokenSha256: createHash("sha256").update(value).digest("hex"),
            issuer: "cookie-qa",
            audience: "booking-qa",
          },
        };
      },
    };
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1::uuid,$2::uuid,'Synthetic auth serialization')`,
        [tenantId, identityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES($1::uuid,$2::uuid)`,
        [tenantId, identityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES($1::uuid,$2::uuid,'owner','QA Owner',
                ARRAY['booking.create'])`,
        [tenantId, roleId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        [tenantId, randomUUID(), identityId, roleId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.telegram_identity_links
           (tenant_id,id,identity_id,telegram_user_hmac_sha256,
            proof_verified_at,consent_confirmed_at)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::bytea,
                clock_timestamp(),clock_timestamp())`,
        [tenantId, linkId, identityId, randomBytes(32)],
      );
      await pool.query(
        `INSERT INTO cookie_identity.opaque_sessions
           (token_sha256,telegram_exchange_sha256,tenant_id,identity_id,
            issuer,audience,expires_at,telegram_link_id)
         VALUES($1::bytea,$2::bytea,$3::uuid,$4::uuid,'cookie-qa',
                'booking-qa',clock_timestamp()+interval '10 minutes',
                $5::uuid)`,
        [tokenHash, randomBytes(32), tenantId, identityId, linkId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.opaque_sessions
           (token_sha256,telegram_exchange_sha256,tenant_id,identity_id,
            issuer,audience,issued_at,expires_at)
         VALUES($1::bytea,$2::bytea,$3::uuid,$4::uuid,'cookie-qa',
                'booking-qa',clock_timestamp()-interval '10 minutes',
                clock_timestamp()-interval '1 minute')`,
        [expiredHash, randomBytes(32), tenantId, identityId],
      );

      const verified = await verifyTenantActor(
        "Bearer " + token,
        tenantId,
        actorVerifier,
      );
      assert.ok(verified.actor);
      assert.equal(
        verified.actor.opaqueSessionAuthority?.tokenSha256,
        tokenHash.toString("hex"),
      );
      const actor = verified.actor;
      const resource = { kind: "organization" as const, tenantId };
      const guarding = await pool.connect();
      const revoking = await pool.connect();
      try {
        for (const override of [
          { issuer: "wrong-issuer" },
          { audience: "wrong-audience" },
        ]) {
          await guarding.query("BEGIN");
          await assert.rejects(
            requireTenantPermission(
              guarding,
              {
                ...actor,
                opaqueSessionAuthority: {
                  ...actor.opaqueSessionAuthority!,
                  ...override,
                },
              },
              resource,
              "booking.create",
            ),
            AuthorizationDeniedError,
          );
          await guarding.query("ROLLBACK");
        }

        await guarding.query("BEGIN");
        await requireTenantPermission(
          guarding,
          actor,
          resource,
          "booking.create",
        );

        // Neither Telegram unlink nor direct bearer revocation can commit
        // while the previously authorized command holds its transaction.
        for (const sql of [
          `UPDATE cookie_identity.telegram_identity_links
             SET revoked_at=clock_timestamp()
           WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          `UPDATE cookie_identity.opaque_sessions
             SET revoked_at=clock_timestamp()
           WHERE token_sha256=$1::bytea AND revoked_at IS NULL`,
        ]) {
          await revoking.query("BEGIN");
          await revoking.query("SET LOCAL lock_timeout='150ms'");
          await assert.rejects(
            revoking.query(
              sql,
              sql.includes("telegram_identity_links")
                ? [tenantId, linkId]
                : [tokenHash],
            ),
            (error: unknown) => {
              assert.equal((error as { code?: string }).code, "55P03");
              return true;
            },
          );
          await revoking.query("ROLLBACK");
        }
        await guarding.query("COMMIT");

        // Revoke-first: a committed Telegram unlink revokes its sessions.
        const unlinked = await pool.query(
          `UPDATE cookie_identity.telegram_identity_links
              SET revoked_at=clock_timestamp()
            WHERE tenant_id=$1::uuid AND id=$2::uuid
              AND revoked_at IS NULL`,
          [tenantId, linkId],
        );
        assert.equal(unlinked.rowCount, 1);

        await guarding.query("BEGIN");
        await assert.rejects(
          requireTenantPermission(guarding, actor, resource, "booking.create"),
          AuthorizationDeniedError,
        );
        await guarding.query("ROLLBACK");

        const expired = await verifyTenantActor(
          "Bearer " + expiredToken,
          tenantId,
          actorVerifier,
        );
        assert.ok(expired.actor);
        await guarding.query("BEGIN");
        await assert.rejects(
          requireTenantPermission(
            guarding,
            expired.actor,
            resource,
            "booking.create",
          ),
          AuthorizationDeniedError,
        );
        await guarding.query("ROLLBACK");

        // A valid hash belonging to one tenant never grants another.
        await guarding.query("BEGIN");
        await assert.rejects(
          requireTenantPermission(
            guarding,
            { ...expired.actor, tenantId: foreignTenantId },
            { kind: "organization", tenantId: foreignTenantId },
            "booking.create",
          ),
          AuthorizationDeniedError,
        );
        await guarding.query("ROLLBACK");
      } finally {
        await guarding.query("ROLLBACK").catch(() => undefined);
        await revoking.query("ROLLBACK").catch(() => undefined);
        guarding.release();
        revoking.release();
      }
    } finally {
      try {
        await pool
          .query(
            "DELETE FROM cookie_identity.authorization_audit WHERE tenant_id=$1::uuid",
            [tenantId],
          )
          .catch(() => undefined);
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
            "DELETE FROM cookie_identity.role_assignments WHERE tenant_id=$1::uuid",
            [tenantId],
          )
          .catch(() => undefined);
        await pool
          .query("DELETE FROM cookie_identity.roles WHERE tenant_id=$1::uuid", [
            tenantId,
          ])
          .catch(() => undefined);
        await pool
          .query(
            "DELETE FROM cookie_identity.memberships WHERE tenant_id=$1::uuid",
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
            identityId,
          ])
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
