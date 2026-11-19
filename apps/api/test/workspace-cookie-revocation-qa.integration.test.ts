import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";
import { createApp } from "../src/app.js";

const BOT = "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026";
const USER = "279058397";
const SECRET = Buffer.alloc(32, 0x5e);

function signedInitData(): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: Number(USER), first_name: "Synthetic" }),
  };
  const payload = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", key).update(payload).digest("hex");
  return (
    Object.entries(fields)
      .map(([name, value]) => name + "=" + encodeURIComponent(value))
      .join("&") +
    "&hash=" +
    hash
  );
}

test(
  "Cookie bearer, expiry and Telegram unlink revoke protected Workspace reads before transaction",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-workspace-cookie-revoke-first",
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const linkId = randomUUID();
    const roleId = randomUUID();
    const locationId = randomUUID();
    const organizationName = "QA protected organization metadata";
    const locationName = "QA protected location metadata";
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
        "INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions) VALUES($1::uuid,$2::uuid,'owner','QA owner',ARRAY['booking.read'])",
        [tenantId, roleId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
        [tenantId, randomUUID(), identityId, roleId],
      );
      const fingerprint = createHmac("sha256", SECRET)
        .update("cookie-telegram-user-fingerprint-v1\0")
        .update(USER)
        .digest();
      await pool.query(
        "INSERT INTO cookie_identity.telegram_identity_links(tenant_id,id,identity_id,telegram_user_hmac_sha256,proof_verified_at,consent_confirmed_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::bytea,clock_timestamp(),clock_timestamp())",
        [tenantId, linkId, identityId, fingerprint],
      );

      const sessions = new PostgresOpaqueTelegramSessions({
        pool,
        fingerprintSecret: SECRET,
        telegramProofVerifier: createTelegramMiniAppProofVerifier({
          botToken: BOT,
          maxAgeSeconds: 600,
        }),
        resolveVerifiedTelegramLink: createPostgresVerifiedTelegramLinkResolver(
          {
            userHashSecret: SECRET,
          },
        ),
        issuer: "cookie-qa",
        audience: "workspace-qa",
        ttlSeconds: 600,
      });
      const route = "/v1/organizations/" + tenantId + "/workspace-context";
      const verifiedApp = createApp(pool, {
        syntheticWorkspaceReads: { pool, verifier: sessions },
      });
      apps.push(verifiedApp);

      for (const kind of [
        "bearer",
        "session-expiry",
        "telegram-unlink",
      ] as const) {
        const issued =
          await sessions.exchangeTelegramInitData(signedInitData());
        assert.ok(
          issued,
          "real signed Telegram proof must exchange through trusted link",
        );

        // A valid Cookie bearer must actually return tenant-scoped metadata.
        // This prevents a vacuous pass caused by universal access denial.
        const positive = await verifiedApp.inject({
          method: "GET",
          url: route,
          headers: { authorization: "Bearer " + issued.bearerToken },
        });
        assert.equal(positive.statusCode, 200);
        assert.equal(
          positive.json().organization.displayName,
          organizationName,
        );
        assert.equal(positive.json().locations[0].displayName, locationName);

        let reached!: () => void;
        const checked = new Promise<void>((done) => {
          reached = done;
        });
        let release!: () => void;
        const released = new Promise<void>((done) => {
          release = done;
        });
        const verifier = {
          async verifyBearerToken(token: string) {
            const session = await sessions.verifyBearerToken(token);
            if (session) {
              reached();
              await released;
            }
            return session;
          },
        };
        const app = createApp(pool, {
          syntheticWorkspaceReads: { pool, verifier },
        });
        apps.push(app);
        const pending = app.inject({
          method: "GET",
          url: route,
          headers: { authorization: "Bearer " + issued.bearerToken },
        });
        try {
          assert.equal(
            await Promise.race([
              checked.then(() => true),
              pending.then(() => false),
            ]),
            true,
            "valid bearer must pass real DB verification before revoke-first interleaving",
          );
          if (kind === "bearer") {
            assert.equal(
              await sessions.revokeBearerToken(issued.bearerToken),
              true,
            );
          } else if (kind === "session-expiry") {
            const expired = await pool.query(
              "UPDATE cookie_identity.opaque_sessions SET issued_at=clock_timestamp()-interval '610 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1::uuid AND token_sha256=$2::bytea AND revoked_at IS NULL RETURNING token_sha256",
              [
                tenantId,
                createHash("sha256").update(issued.bearerToken).digest(),
              ],
            );
            assert.equal(expired.rowCount, 1);
          } else {
            const unlinked = await pool.query(
              "UPDATE cookie_identity.telegram_identity_links SET revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::uuid AND revoked_at IS NULL",
              [tenantId, linkId],
            );
            assert.equal(unlinked.rowCount, 1);
          }
          assert.equal(
            await sessions.verifyBearerToken(issued.bearerToken),
            null,
            "revocation or expiry is committed before the HTTP read resumes",
          );
        } finally {
          release();
        }

        const result = await pending;
        assert.ok(
          result.statusCode === 401 || result.statusCode === 403,
          kind + " must deny stale preflight claims; got " + result.statusCode,
        );
        assert.ok(!result.body.includes(organizationName));
        assert.ok(!result.body.includes(locationName));

        const nextRead = await verifiedApp.inject({
          method: "GET",
          url: route,
          headers: { authorization: "Bearer " + issued.bearerToken },
        });
        assert.equal(
          nextRead.statusCode,
          401,
          "subsequent AuthN must reject lost authority",
        );
        await app.close();
      }
      const membership = await pool.query<{ active: boolean }>(
        "SELECT active FROM cookie_identity.memberships WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
        [tenantId, identityId],
      );
      assert.equal(membership.rows[0]?.active, true);
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
            .query("DELETE FROM " + table + " WHERE tenant_id=$1::uuid", [
              tenantId,
            ])
            .catch(() => undefined);
        }
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
