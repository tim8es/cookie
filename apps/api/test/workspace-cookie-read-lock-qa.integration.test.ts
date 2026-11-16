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
  "Workspace HTTP read retains bearer/link authorization locks until its transaction commits",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-workspace-cookie-read-lock",
      max: 6,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const roleId = randomUUID();
    const linkId = randomUUID();
    const locationId = randomUUID();
    const organizationName = "QA transaction-protected salon";
    const locationName = "QA transaction-protected branch";
    const apps: Array<ReturnType<typeof createApp>> = [];

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES($1::uuid,$2::uuid,$3::text)",
        [tenantId, identityId, organizationName],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone) VALUES($1::uuid,$2::uuid,$3::text,'UTC')",
        [tenantId, locationId, locationName],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1::uuid,$2::uuid)",
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions) VALUES($1::uuid,$2::uuid,'owner','QA Owner',ARRAY['booking.read'])",
        [tenantId, roleId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
        [tenantId, randomUUID(), identityId, roleId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.telegram_identity_links(tenant_id,id,identity_id,telegram_user_hmac_sha256,proof_verified_at,consent_confirmed_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::bytea,clock_timestamp(),clock_timestamp())",
        [tenantId, linkId, identityId, randomBytes(32)],
      );

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
      const route = "/v1/organizations/" + tenantId + "/workspace-context";
      const tokenHash = (token: string): Buffer => createHash("sha256").update(token).digest();
      const normalApp = createApp(pool, {
        syntheticWorkspaceReads: { pool, verifier: sessions },
      });
      apps.push(normalApp);

      for (const kind of ["bearer", "telegram-link"] as const) {
        const token = "cs_" + randomBytes(32).toString("base64url");
        await pool.query(
          `INSERT INTO cookie_identity.opaque_sessions
             (token_sha256,telegram_exchange_sha256,tenant_id,identity_id,
              issuer,audience,expires_at,telegram_link_id)
           VALUES($1::bytea,$2::bytea,$3::uuid,$4::uuid,'cookie-qa',
                  'workspace-qa',clock_timestamp()+interval '10 minutes',$5::uuid)`,
          [tokenHash(token), randomBytes(32), tenantId, identityId, linkId],
        );
        assert.ok(await sessions.verifyBearerToken(token), "real provider must authorize current token");
        const positive = await normalApp.inject({
          method: "GET",
          url: route,
          headers: { authorization: "Bearer " + token },
        });
        assert.equal(positive.statusCode, 200, positive.body);
        assert.equal(positive.json().organization.displayName, organizationName);
        assert.equal(positive.json().locations[0].displayName, locationName);

        let reached!: () => void;
        const checked = new Promise<void>((done) => {
          reached = done;
        });
        let release!: () => void;
        const released = new Promise<void>((done) => {
          release = done;
        });
        let intercepted = false;
        // Proxy only the workspace read's transactional PoolClient.
        // The checkpoint is AFTER the real PostgreSQL link+session
        // FOR SHARE guards, but BEFORE the first protected metadata read.
        const gatedPool = {
          connect: async (): Promise<PoolClient> => {
            const client = await pool.connect();
            const originalQuery = client.query.bind(client) as (
              statement: string,
              values?: unknown[],
            ) => Promise<unknown>;
            return new Proxy(client, {
              get(target, property) {
                if (property === "query") {
                  return async (statement: string, values?: unknown[]) => {
                    if (
                      !intercepted &&
                      statement.includes(
                        "SELECT display_name FROM cookie_tenancy.organizations",
                      )
                    ) {
                      intercepted = true;
                      reached();
                      await released;
                    }
                    return originalQuery(statement, values);
                  };
                }
                if (property === "release") return target.release.bind(target);
                return Reflect.get(target, property, target);
              },
            });
          },
        } as unknown as Pool;
        const app = createApp(pool, {
          syntheticWorkspaceReads: { pool: gatedPool, verifier: sessions },
        });
        apps.push(app);
        const pending = app.inject({
          method: "GET",
          url: route,
          headers: { authorization: "Bearer " + token },
        });
        let blockedByGuard = false;
        let committedWhileReadHeld = false;
        try {
          assert.equal(
            await Promise.race([
              checked.then(() => true),
              pending.then(() => false),
            ]),
            true,
            "authorized read must reach checkpoint after session/link FOR SHARE",
          );
          const revoker = await pool.connect();
          try {
            await revoker.query("BEGIN");
            await revoker.query("SET LOCAL lock_timeout='350ms'");
            try {
              if (kind === "bearer") {
                await revoker.query(
                  "UPDATE cookie_identity.opaque_sessions SET revoked_at=clock_timestamp() WHERE token_sha256=$1::bytea AND revoked_at IS NULL",
                  [tokenHash(token)],
                );
              } else {
                await revoker.query(
                  "UPDATE cookie_identity.telegram_identity_links SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::uuid AND revoked_at IS NULL",
                  [tenantId, linkId],
                );
              }
              await revoker.query("COMMIT");
              committedWhileReadHeld = true;
            } catch (error) {
              await revoker.query("ROLLBACK").catch(() => undefined);
              assert.equal(
                (error as { code?: string }).code,
                "55P03",
                "only PostgreSQL lock timeout counts as a serialized revocation",
              );
              blockedByGuard = true;
            }
          } finally {
            revoker.release();
          }
        } finally {
          release();
        }

        const result = await pending;
        assert.equal(
          committedWhileReadHeld,
          false,
          kind + " revocation must not commit while prior read holds its session/link guard",
        );
        assert.equal(blockedByGuard, true, "independent revoker must conflict with FOR SHARE");
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().organization.displayName, organizationName);
        assert.equal(result.json().locations[0].displayName, locationName);
        await app.close();

        // Once the protected read COMMIT has released its locks, the exact
        // revocation must succeed and all subsequent reads must deny.
        if (kind === "bearer") {
          assert.equal(await sessions.revokeBearerToken(token), true);
        } else {
          const revoked = await pool.query(
            "UPDATE cookie_identity.telegram_identity_links SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::uuid AND revoked_at IS NULL",
            [tenantId, linkId],
          );
          assert.equal(revoked.rowCount, 1);
        }
        assert.equal(await sessions.verifyBearerToken(token), null);
        const denied = await normalApp.inject({
          method: "GET",
          url: route,
          headers: { authorization: "Bearer " + token },
        });
        assert.equal(denied.statusCode, 401);
        assert.ok(!denied.body.includes(organizationName));
        assert.ok(!denied.body.includes(locationName));
      }
    } finally {
      for (const app of apps) await app.close().catch(() => undefined);
      try {
        for (const table of [
          "cookie_identity.authorization_audit",
          "cookie_identity.opaque_sessions",
          "cookie_identity.telegram_identity_links",
          "cookie_identity.role_assignments",
          "cookie_identity.roles",
          "cookie_identity.memberships",
          "cookie_tenancy.locations",
        ]) {
          await pool
            .query("DELETE FROM " + table + " WHERE tenant_id=$1::uuid", [tenantId])
            .catch(() => undefined);
        }
        await pool
          .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [tenantId])
          .catch(() => undefined);
        await pool
          .query("DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [identityId])
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
