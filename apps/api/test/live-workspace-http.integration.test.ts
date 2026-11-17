import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createLiveTelegramSessionProvider } from "../src/telegram-auth-runtime.js";

const BOT = "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026";
const SECRET = Buffer.alloc(32, 0x59);
const USER_ID = 279058398;

function signedProof(userId = USER_ID): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: userId, first_name: "Synthetic" }),
  };
  const payload = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(BOT).digest();
  const signature = createHmac("sha256", key).update(payload).digest("hex");
  return (
    Object.entries(fields)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&") +
    "&hash=" +
    signature
  );
}

test(
  "live workspace overview reads real Postgres tenant data only for current signed session",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-live-workspace-overview-qa",
      max: 6,
      connectionTimeoutMillis: 5_000,
    });
    const ownerIdentityId = randomUUID();
    const otherIdentityId = randomUUID();
    const proofVerifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 300,
    });
    const auth = createLiveTelegramSessionProvider(
      {
        COOKIE_TELEGRAM_AUTH_MODE: "enabled",
        COOKIE_PUBLIC_ORIGIN: "https://staging.example.test",
        COOKIE_TELEGRAM_BOT_TOKEN: BOT,
        COOKIE_TELEGRAM_USER_HMAC_SECRET: SECRET.toString("hex"),
      },
      pool,
    );
    assert.ok(auth);
    const app = createApp(pool, {
      telegramAuthRoutes: { sessions: auth },
      liveWorkspaceReads: { pool, verifier: auth },
    });
    const noAuthApp = createApp(pool);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1),($2)",
        [ownerIdentityId, otherIdentityId],
      );
      const workspace = await provisionOwnerWorkspace(pool, {
        ownerIdentityId,
        idempotencyKey: "real-workspace-" + randomUUID(),
        organizationName: "Real staging salon",
        locationName: "Первая студия",
        timeZone: "Europe/Moscow",
      });
      const foreign = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: otherIdentityId,
        idempotencyKey: "foreign-workspace-" + randomUUID(),
        organizationName: "Other tenant secret",
        locationName: "Invisible branch",
        timeZone: "UTC",
      });
      const secondLocationId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_tenancy.locations
           (tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'Second branch','Europe/Moscow')`,
        [workspace.tenantId, secondLocationId],
      );
      await linkVerifiedTelegramOwner(pool, proofVerifier, SECRET, {
        tenantId: workspace.tenantId,
        ownerIdentityId,
        rawInitData: signedProof(),
        consentConfirmed: true,
      });
      const authResponse = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signedProof() },
      });
      assert.equal(authResponse.statusCode, 201);
      const bearer = authResponse.json().accessToken as string;
      const url = `/v1/organizations/${workspace.tenantId}/workspace-overview`;

      const routeDisabled = await noAuthApp.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${bearer}` },
      });
      assert.equal(routeDisabled.statusCode, 404);

      const missing = await app.inject({ method: "GET", url });
      assert.equal(missing.statusCode, 401);
      assert.equal(missing.headers["cache-control"], "no-store");

      const crossTenant = await app.inject({
        method: "GET",
        url: `/v1/organizations/${foreign.tenantId}/workspace-overview`,
        headers: { authorization: `Bearer ${bearer}` },
      });
      assert.equal(crossTenant.statusCode, 403);
      assert.doesNotMatch(
        crossTenant.body,
        /Other tenant secret|Invisible branch/,
      );

      const allowed = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${bearer}` },
      });
      assert.equal(allowed.statusCode, 200);
      assert.equal(allowed.headers["cache-control"], "no-store");
      assert.equal(allowed.headers.vary, "Authorization");
      const result = allowed.json();
      assert.deepEqual(result, {
        organization: {
          organizationId: workspace.tenantId,
          displayName: "Real staging salon",
        },
        locations: [
          {
            locationId: secondLocationId,
            displayName: "Second branch",
            timeZone: "Europe/Moscow",
          },
          {
            locationId: workspace.locationId,
            displayName: "Первая студия",
            timeZone: "Europe/Moscow",
          },
        ],
      });
      assert.doesNotMatch(allowed.body, /Other tenant secret|Invisible branch/);

      // Role revocation before the HTTP request must immediately deny metadata.
      await pool.query(
        `UPDATE cookie_identity.roles
            SET active=false
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [workspace.tenantId, workspace.roleId],
      );
      const revokedRole = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${bearer}` },
      });
      assert.equal(revokedRole.statusCode, 403);
      assert.doesNotMatch(revokedRole.body, /Real staging salon|Первая студия/);

      await pool.query(
        `UPDATE cookie_identity.roles
            SET active=true
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [workspace.tenantId, workspace.roleId],
      );
      assert.equal(await auth.revokeBearerToken(bearer), true);
      const revokedBearer = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${bearer}` },
      });
      assert.equal(revokedBearer.statusCode, 401);
    } finally {
      await app.close();
      await noAuthApp.close();
      await pool.end();
    }
  },
);
