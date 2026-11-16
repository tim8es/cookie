import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createApp } from "../src/app.js";

test(
  "workspace read must not disclose a revoked role after the revocation commits first",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-workspace-role-revoke-race",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const roleId = randomUUID();
    const locationId = randomUUID();
    const token = "cs_" + randomBytes(32).toString("base64url");
    const organizationName = "QA revocation protected organization";
    const locationName = "QA revocation protected location";

    let reachPolicyRead!: () => void;
    let releasePolicyRead!: () => void;
    const policyRead = new Promise<void>((resolve) => {
      reachPolicyRead = resolve;
    });
    const policyRelease = new Promise<void>((resolve) => {
      releasePolicyRead = resolve;
    });
    let intercepted = false;

    // A test-only PoolClient adapter holds the *already-completed* actual
    // PostgreSQL policy SELECT response, not the SQL itself. Any revocation
    // that commits here precedes the HTTP read's authorization decision.
    const interceptPool = {
      async connect(): Promise<PoolClient> {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (sql: string, params?: unknown[]) => {
                const result = await target.query(sql, params);
                if (
                  !intercepted &&
                  typeof sql === "string" &&
                  sql.includes(
                    "LEFT JOIN cookie_identity.role_assignments AS ra",
                  )
                ) {
                  intercepted = true;
                  reachPolicyRead();
                  await policyRelease;
                }
                return result;
              };
            }
            if (property === "release") return target.release.bind(target);
            return Reflect.get(target, property, target);
          },
        });
      },
    } as Pool;

    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: createTelegramMiniAppProofVerifier({
        botToken: "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026",
        maxAgeSeconds: 600,
      }),
      resolveVerifiedTelegramLink: async () => null,
      issuer: "cookie-qa",
      audience: "workspace-qa",
      ttlSeconds: 600,
    });
    const app = createApp(pool, {
      syntheticWorkspaceReads: { pool: interceptPool, verifier: sessions },
    });
    const route = `/v1/organizations/${tenantId}/workspace-context`;
    const send = () =>
      app.inject({
        method: "GET",
        url: route,
        headers: { authorization: "Bearer " + token },
      });

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1)",
        [identityId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1,$2,$3)`,
        [tenantId, identityId, organizationName],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES($1,$2,$3,'UTC')`,
        [tenantId, locationId, locationName],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1,$2)",
        [tenantId, identityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions)
         VALUES($1,$2,'owner','QA Owner',ARRAY['booking.read'])`,
        [tenantId, roleId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id)
         VALUES($1,$2,$3,$4)`,
        [tenantId, randomUUID(), identityId, roleId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.opaque_sessions
           (token_sha256,telegram_exchange_sha256,tenant_id,identity_id,
            issuer,audience,expires_at)
         VALUES($1::bytea,$2::bytea,$3::uuid,$4::uuid,'cookie-qa',
                'workspace-qa',clock_timestamp()+interval '10 minutes')`,
        [
          createHash("sha256").update(token).digest(),
          randomBytes(32),
          tenantId,
          identityId,
        ],
      );
      assert.ok(await sessions.verifyBearerToken(token));

      const request = send();
      await policyRead;

      // Concurrent, committed authorization change from an independent
      // PostgreSQL session. A correct FOR SHARE authorization lock may
      // make this UPDATE time out instead of committing ahead of the read.
      const revoker = await pool.connect();
      let revokedFirst = false;
      try {
        await revoker.query("BEGIN");
        await revoker.query("SET LOCAL lock_timeout='250ms'");
        try {
          const update = await revoker.query(
            `UPDATE cookie_identity.roles SET active=false
              WHERE tenant_id=$1::uuid AND id=$2::uuid AND active`,
            [tenantId, roleId],
          );
          assert.equal(update.rowCount, 1);
          await revoker.query("COMMIT");
          revokedFirst = true;
        } catch (error) {
          assert.equal(
            (error as { code?: string }).code,
            "55P03",
            "only authoritative policy row locking may prevent revoke-first",
          );
          await revoker.query("ROLLBACK");
        }
      } finally {
        revoker.release();
        releasePolicyRead();
      }

      const response = await request;
      assert.equal(
        response.statusCode,
        revokedFirst ? 403 : 200,
        "workspace metadata must not be exposed when role revoke committed before HTTP policy decision",
      );
      if (revokedFirst) {
        assert.ok(!response.body.includes(organizationName));
        assert.ok(!response.body.includes(locationName));
      } else {
        assert.equal(
          response.json().organization.displayName,
          organizationName,
        );
      }

      // Sequential revocation is a separate control; it must still deny.
      if (!revokedFirst) {
        await pool.query(
          "UPDATE cookie_identity.roles SET active=false WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, roleId],
        );
      }
      assert.equal((await send()).statusCode, 403);
    } finally {
      releasePolicyRead();
      await app.close().catch(() => undefined);
      try {
        await pool.query(
          "DELETE FROM cookie_identity.authorization_audit WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.role_assignments WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.roles WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.memberships WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.locations WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [identityId],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
