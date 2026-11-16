import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { verifyTenantActor } from "../src/session-context.js";

const BOT = "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026";
const TELEGRAM_ID = 279058397;

function signedInitData(queryId: string, userId = TELEGRAM_ID): string {
  const fields = {
    query_id: queryId,
    user: JSON.stringify({ id: userId, first_name: "Synthetic" }),
    auth_date: String(Math.floor(Date.now() / 1_000)),
    signature: "synthetic-third-party-signature-in-hmac",
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return (
    Object.entries(fields)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&") +
    "&hash=" +
    hash
  );
}

test(
  "Telegram proof exchanges once to hashed revocable tenant session; inactive membership never resurrects it",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-opaque-telegram-session",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const tenantId = randomUUID();
    const outsiderTenantId = randomUUID();
    const identityId = randomUUID();
    let lookups = 0;
    let allowLink = true;
    let breakLink = false;
    const proofVerifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 600,
    });
    const resolveVerifiedTelegramLink = async (
      _client: unknown,
      proof: { readonly telegramUserId: string },
    ) => {
      lookups++;
      if (breakLink) throw new Error("SYNTHETIC_LINK_RESOLVER_FAILURE");
      if (!allowLink || proof.telegramUserId !== String(TELEGRAM_ID))
        return null;
      return { tenantId, identityId };
    };
    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: proofVerifier,
      resolveVerifiedTelegramLink,
      issuer: "cookie-f1-test",
      audience: "cookie-booking-test",
      ttlSeconds: 1_800,
    });
    const wrongAudience = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: proofVerifier,
      resolveVerifiedTelegramLink,
      issuer: "cookie-f1-test",
      audience: "unrelated-api",
      ttlSeconds: 1_800,
    });
    const wrongIssuer = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: proofVerifier,
      resolveVerifiedTelegramLink,
      issuer: "untrusted-issuer",
      audience: "cookie-booking-test",
      ttlSeconds: 1_800,
    });

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES ($1::uuid,$2::uuid,'Synthetic Telegram session tenant')`,
        [tenantId, identityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES($1::uuid,$2::uuid)`,
        [tenantId, identityId],
      );

      assert.equal(await sessions.exchangeTelegramInitData(undefined), null);
      assert.equal(
        await sessions.exchangeTelegramInitData("forged=bad&hash=bad"),
        null,
      );
      assert.equal(lookups, 0, "invalid proof cannot reach Identity resolver");
      assert.equal(
        await sessions.exchangeTelegramInitData(signedInitData("unknown", 123)),
        null,
      );
      assert.equal(
        lookups,
        1,
        "valid proof goes to explicit link resolver only",
      );

      const originalRaw = signedInitData("first-launch");
      breakLink = true;
      await assert.rejects(
        sessions.exchangeTelegramInitData(originalRaw),
        /SYNTHETIC_LINK_RESOLVER_FAILURE/,
      );
      breakLink = false;
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM cookie_identity.opaque_sessions WHERE tenant_id=$1",
            [tenantId],
          )
        ).rows[0]?.n,
        0,
        "failing trusted resolver must not consume proof or create session",
      );

      const created = await sessions.exchangeTelegramInitData(originalRaw);
      assert.ok(created);
      assert.match(created.bearerToken, /^cs_[A-Za-z0-9_-]{43}$/);
      assert.ok(created.expiresAtUnixSeconds > Date.now() / 1_000);
      const authenticated = await sessions.verifyBearerToken(
        created.bearerToken,
      );
      assert.deepEqual(authenticated, {
        tenantId,
        identityId,
        expiresAtUnixSeconds: created.expiresAtUnixSeconds,
      });

      const rawDigest = createHash("sha256")
        .update(created.bearerToken)
        .digest("hex");
      const recorded = await pool.query<{
        hash: string;
        issuer: string;
        audience: string;
        consumed: string;
      }>(
        `SELECT encode(token_sha256,'hex') AS hash,
                encode(telegram_exchange_sha256,'hex') AS consumed,
                issuer,audience
           FROM cookie_identity.opaque_sessions
          WHERE tenant_id=$1::uuid`,
        [tenantId],
      );
      assert.equal(recorded.rows.length, 1);
      assert.equal(recorded.rows[0]?.hash, rawDigest);
      assert.equal(recorded.rows[0]?.issuer, "cookie-f1-test");
      assert.equal(recorded.rows[0]?.audience, "cookie-booking-test");
      assert.notEqual(recorded.rows[0]?.consumed, rawDigest);
      assert.equal(await sessions.exchangeTelegramInitData(originalRaw), null);
      assert.equal(
        await sessions.exchangeTelegramInitData(
          originalRaw.split("&").reverse().join("&"),
        ),
        null,
        "reordering a valid Telegram query may not reuse a consumed proof",
      );

      // Simultaneous exchanges of the same verified HMAC must serialize at
      // the unique DB nonce: exactly one session is minted, never two.
      const parallelRaw = signedInitData("parallel-launch");
      const concurrent = await Promise.all([
        sessions.exchangeTelegramInitData(parallelRaw),
        sessions.exchangeTelegramInitData(parallelRaw),
      ]);
      assert.equal(concurrent.filter(Boolean).length, 1);

      assert.equal(await sessions.verifyBearerToken("fake"), null);
      assert.equal(
        await sessions.verifyBearerToken("cs_" + "f".repeat(43)),
        null,
      );
      assert.equal(
        await wrongAudience.verifyBearerToken(created.bearerToken),
        null,
      );
      assert.equal(
        await wrongIssuer.verifyBearerToken(created.bearerToken),
        null,
      );
      assert.equal(
        await wrongAudience.revokeBearerToken(created.bearerToken),
        false,
      );
      const forbidden = await verifyTenantActor(
        "Bearer " + created.bearerToken,
        outsiderTenantId,
        sessions,
      );
      assert.equal(
        forbidden.status,
        403,
        "path tenant cannot override verified session",
      );

      assert.equal(await sessions.revokeBearerToken(created.bearerToken), true);
      assert.equal(
        await sessions.revokeBearerToken(created.bearerToken),
        false,
      );
      assert.equal(await sessions.verifyBearerToken(created.bearerToken), null);

      const next = await sessions.exchangeTelegramInitData(
        signedInitData("second-launch"),
      );
      assert.ok(next);
      assert.ok(await sessions.verifyBearerToken(next.bearerToken));
      await pool.query(
        `UPDATE cookie_identity.memberships SET active=false
          WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenantId, identityId],
      );
      assert.equal(await sessions.verifyBearerToken(next.bearerToken), null);
      assert.equal(
        await sessions.exchangeTelegramInitData(
          signedInitData("disabled-membership"),
        ),
        null,
        "active tenant membership must be checked before token mint",
      );
      await pool.query(
        `UPDATE cookie_identity.memberships SET active=true
          WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenantId, identityId],
      );
      assert.equal(
        await sessions.verifyBearerToken(next.bearerToken),
        null,
        "re-enabled membership must not resurrect an earlier bearer",
      );
      const third = await sessions.exchangeTelegramInitData(
        signedInitData("third-launch"),
      );
      assert.ok(third);

      // This is a DB clock expiry check, not a caller-controlled JWT exp claim.
      await pool.query(
        `UPDATE cookie_identity.opaque_sessions
            SET issued_at=clock_timestamp()-interval '2 hours',
                expires_at=clock_timestamp()-interval '1 hour'
          WHERE token_sha256=$1::bytea`,
        [createHash("sha256").update(third.bearerToken).digest()],
      );
      assert.equal(await sessions.verifyBearerToken(third.bearerToken), null);
      allowLink = false;
      assert.equal(
        await sessions.exchangeTelegramInitData(signedInitData("unlinked")),
        null,
      );
    } finally {
      await pool
        .query(
          "DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1",
          [tenantId],
        )
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.memberships WHERE tenant_id=$1", [
          tenantId,
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1", [
          tenantId,
        ])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.identities WHERE id=$1", [
          identityId,
        ])
        .catch(() => undefined);
      await pool.end();
    }
  },
);

test("opaque session provider configuration refuses broad implicit issuance", () => {
  const bad = [
    { issuer: "", audience: "booking", ttlSeconds: 600 },
    { issuer: "test", audience: "", ttlSeconds: 600 },
    { issuer: "test", audience: "booking", ttlSeconds: 0 },
    { issuer: "test", audience: "booking", ttlSeconds: 3_601 },
    { issuer: "test", audience: "booking", ttlSeconds: Number.NaN },
  ];
  for (const item of bad) {
    assert.throws(
      () =>
        new PostgresOpaqueTelegramSessions({
          pool: {} as Pool,
          telegramProofVerifier: { verify: () => null },
          resolveVerifiedTelegramLink: async () => null,
          ...item,
        }),
    );
  }
});
