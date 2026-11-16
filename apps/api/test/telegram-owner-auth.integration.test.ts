import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createLiveTelegramSessionProvider } from "../src/telegram-auth-runtime.js";
import { postgresTenantPolicyGuard } from "../src/session-context.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";

const BOT = "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026";
const SECRET = Buffer.alloc(32, 0x7f);
const USER = 279058397;

function signedInitData(id = USER): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id, first_name: "Synthetic" }),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return (
    Object.entries(fields)
      .map(([key, value]) => key + "=" + encodeURIComponent(value))
      .join("&") +
    "&hash=" +
    hash
  );
}

test(
  "real Telegram proof links pre-provisioned owner and issues revocable Cookie bearer",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-telegram-auth-integration",
      max: 5,
    });
    const ownerIdentityId = randomUUID();
    const anotherOwner = randomUUID();
    const verifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 300,
    });
    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: verifier,
      resolveVerifiedTelegramLink: createPostgresVerifiedTelegramLinkResolver({
        userHashSecret: SECRET,
      }),
      issuer: "cookie-telegram",
      audience: "cookie-web",
      ttlSeconds: 900,
    });
    const app = createApp(pool, {
      telegramAuthRoutes: { sessions },
      sessionRoutes: {
        verifier: sessions,
        policy: postgresTenantPolicyGuard(pool),
      },
    });
    const defaultApp = createApp(pool);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1),($2)",
        [ownerIdentityId, anotherOwner],
      );
      const setup = await provisionOwnerWorkspace(pool, {
        ownerIdentityId,
        organizationName: "Synthetic owner salon",
        locationName: "Main",
        timeZone: "Europe/Moscow",
        idempotencyKey: "telegram-link-" + randomUUID(),
      });
      const anotherSetup = await provisionOwnerWorkspace(pool, {
        ownerIdentityId: anotherOwner,
        organizationName: "Other synthetic tenant",
        locationName: "Other",
        timeZone: "UTC",
        idempotencyKey: "other-tenant-" + randomUUID(),
      });
      const raw = signedInitData();
      const link = await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: setup.tenantId,
        ownerIdentityId,
        rawInitData: raw,
        consentConfirmed: true,
      });
      assert.equal(link.replayed, false);
      const again = await linkVerifiedTelegramOwner(pool, verifier, SECRET, {
        tenantId: setup.tenantId,
        ownerIdentityId,
        rawInitData: raw,
        consentConfirmed: true,
      });
      assert.equal(again.linkId, link.linkId);
      assert.equal(again.replayed, true);
      await assert.rejects(
        linkVerifiedTelegramOwner(pool, verifier, SECRET, {
          tenantId: anotherSetup.tenantId,
          ownerIdentityId: anotherOwner,
          rawInitData: raw,
          consentConfirmed: true,
        }),
        { code: "LINK_CONFLICT" },
      );
      await assert.rejects(
        linkVerifiedTelegramOwner(pool, verifier, SECRET, {
          tenantId: setup.tenantId,
          ownerIdentityId,
          rawInitData: signedInitData(USER + 1),
          consentConfirmed: true,
        }),
        { code: "LINK_CONFLICT" },
      );

      const unknownApp = await defaultApp.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: raw },
      });
      assert.equal(unknownApp.statusCode, 404);
      const invalidBody = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: raw, tenantId: anotherSetup.tenantId },
      });
      assert.equal(invalidBody.statusCode, 400);

      const invalidProof = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: signedInitData(USER + 1) },
      });
      assert.equal(invalidProof.statusCode, 401);
      const first = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: raw },
      });
      assert.equal(first.statusCode, 201);
      assert.equal(first.headers["cache-control"], "no-store");
      const receipt = first.json();
      assert.equal(receipt.tokenType, "Bearer");
      assert.equal(receipt.tenantId, setup.tenantId);
      assert.match(receipt.accessToken, /^cs_[A-Za-z0-9_-]{43}$/);
      const stored = await pool.query<{ token_sha256: Buffer }>(
        "SELECT token_sha256 FROM cookie_identity.opaque_sessions WHERE tenant_id=$1::uuid",
        [setup.tenantId],
      );
      assert.equal(stored.rowCount, 1);
      assert.notEqual(
        stored.rows[0]?.token_sha256.toString("utf8"),
        receipt.accessToken,
      );
      const context = await app.inject({
        method: "GET",
        url: `/v1/organizations/${setup.tenantId}/session-context`,
        headers: { authorization: `Bearer ${receipt.accessToken}` },
      });
      assert.equal(context.statusCode, 200);
      assert.deepEqual(context.json(), { tenantId: setup.tenantId });
      const foreign = await app.inject({
        method: "GET",
        url: `/v1/organizations/${anotherSetup.tenantId}/session-context`,
        headers: { authorization: `Bearer ${receipt.accessToken}` },
      });
      assert.equal(foreign.statusCode, 403);

      const replay = await app.inject({
        method: "POST",
        url: "/v1/auth/telegram/exchange",
        payload: { initData: raw },
      });
      assert.equal(replay.statusCode, 401);

      assert.equal(await sessions.revokeBearerToken(receipt.accessToken), true);
      const denied = await app.inject({
        method: "GET",
        url: `/v1/organizations/${setup.tenantId}/session-context`,
        headers: { authorization: `Bearer ${receipt.accessToken}` },
      });
      assert.equal(denied.statusCode, 401);
    } finally {
      await app.close();
      await defaultApp.close();
      await pool.end();
    }
  },
);

test(
  "Telegram auth production config refuses unsafe missing TLS and secrets",
  () => {
    const pool = {} as Pool;
    assert.equal(createLiveTelegramSessionProvider({}, pool), null);
    assert.throws(
      () =>
        createLiveTelegramSessionProvider(
          { COOKIE_TELEGRAM_AUTH_MODE: "yes" },
          pool,
        ),
      /COOKIE_TELEGRAM_AUTH_MODE/,
    );
    assert.throws(
      () =>
        createLiveTelegramSessionProvider(
          { COOKIE_TELEGRAM_AUTH_MODE: "enabled" },
          pool,
        ),
      /HMAC_SECRET/,
    );
    assert.throws(
      () =>
        createLiveTelegramSessionProvider(
          {
            COOKIE_TELEGRAM_AUTH_MODE: "enabled",
            COOKIE_TELEGRAM_USER_HMAC_SECRET: SECRET.toString("hex"),
            COOKIE_TELEGRAM_BOT_TOKEN: BOT,
            COOKIE_PUBLIC_ORIGIN: "http://example.com",
          },
          pool,
        ),
      /HTTPS/,
    );
  },
);
