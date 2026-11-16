import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import { createPostgresVerifiedTelegramLinkResolver } from "../../../packages/platform-identity/src/telegram-links.js";

const BOT = "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026";
const TELEGRAM_ID = "279058397";
const SECRET = Buffer.alloc(32, 0x5e); // Synthetic secret only. Never a production credential.

function signed(userId: string, nonce = randomUUID()): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: nonce,
    user: JSON.stringify({ id: Number(userId), first_name: "Synthetic" }),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const derivedKey = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", derivedKey).update(check).digest("hex");
  return (
    Object.entries(fields)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&") + "&hash=" + hash
  );
}

function fingerprint(id: string): Buffer {
  return createHmac("sha256", SECRET)
    .update("cookie-telegram-user-fingerprint-v1\0")
    .update(id)
    .digest();
}

test(
  "consented Telegram link resolves only an unambiguous tenant and revocation invalidates the bound Cookie bearer",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-trusted-telegram-links",
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const identityA = randomUUID();
    const identityB = randomUUID();
    const linkA = randomUUID();
    const linkB = randomUUID();
    const linkNew = randomUUID();
    const resolver = createPostgresVerifiedTelegramLinkResolver({
      userHashSecret: SECRET,
    });
    const proofVerifier = createTelegramMiniAppProofVerifier({
      botToken: BOT,
      maxAgeSeconds: 600,
    });
    const sessions = new PostgresOpaqueTelegramSessions({
      pool,
      telegramProofVerifier: proofVerifier,
      resolveVerifiedTelegramLink: resolver,
      issuer: "cookie-qa-trusted-link",
      audience: "cookie-qa-session",
      ttlSeconds: 600,
    });
    const insertLink = async (
      tenantId: string,
      identityId: string,
      id: string,
      userId = TELEGRAM_ID,
    ) =>
      pool.query(
        `INSERT INTO cookie_identity.telegram_identity_links
           (tenant_id,id,identity_id,telegram_user_hmac_sha256,
            proof_verified_at,consent_confirmed_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::bytea,
                 clock_timestamp(),clock_timestamp())`,
        [tenantId, id, identityId, fingerprint(userId)],
      );

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid)",
        [identityA, identityB],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'Synthetic Telegram Org A'),
                ($2::uuid,$4::uuid,'Synthetic Telegram Org B')`,
        [tenantA, tenantB, identityA, identityB],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$3::uuid),($2::uuid,$4::uuid)`,
        [tenantA, tenantB, identityA, identityB],
      );

      // HMAC verification alone must NEVER create a Customer, Identity, link
      // or Cookie session. An approved trusted provisioning step is missing.
      assert.equal(await sessions.exchangeTelegramInitData(signed(TELEGRAM_ID)), null);
      const noLink = await pool.query(
        "SELECT count(*)::int AS n FROM cookie_identity.telegram_identity_links WHERE tenant_id=$1::uuid",
        [tenantA],
      );
      assert.equal(noLink.rows[0]?.n, 0);

      await insertLink(tenantA, identityA, linkA);
      const untrustedAlias = await sessions.exchangeTelegramInitData(
        signed("279058398"),
      );
      assert.equal(untrustedAlias, null);

      const first = await sessions.exchangeTelegramInitData(signed(TELEGRAM_ID));
      assert.ok(first);
      const verified = await sessions.verifyBearerToken(first.bearerToken);
      assert.deepEqual(verified, {
        tenantId: tenantA,
        identityId: identityA,
        expiresAtUnixSeconds: first.expiresAtUnixSeconds,
      });
      const persisted = await pool.query<{
        link_id: string;
        token_hash: string;
      }>(
        `SELECT telegram_link_id::text AS link_id,
                encode(token_sha256,'hex') AS token_hash
           FROM cookie_identity.opaque_sessions
          WHERE tenant_id=$1::uuid AND telegram_link_id=$2::uuid`,
        [tenantA, linkA],
      );
      assert.equal(persisted.rows.length, 1);
      assert.equal(persisted.rows[0]?.link_id, linkA);
      assert.equal(
        persisted.rows[0]?.token_hash,
        createHash("sha256").update(first.bearerToken).digest("hex"),
      );
      assert.equal(
        persisted.rows[0]?.token_hash.includes(first.bearerToken),
        false,
      );

      // A Telegram account may belong to multiple organizations; without a
      // reviewed tenant chooser the server must deny the ambiguous exchange.
      await insertLink(tenantB, identityB, linkB);
      assert.equal(await sessions.exchangeTelegramInitData(signed(TELEGRAM_ID)), null);
      assert.ok(
        await sessions.verifyBearerToken(first.bearerToken),
        "existing token is scoped to tenant A, never silently moved to B",
      );
      await assert.rejects(
        insertLink(tenantA, identityA, randomUUID()),
        { code: "23505" },
        "a second active link for one Telegram identity in one tenant is forbidden",
      );
      await assert.rejects(
        insertLink(tenantA, identityB, randomUUID(), "999999"),
        { code: "23503" },
        "a foreign-tenant Identity cannot be linked to this tenant",
      );

      await pool.query(
        `UPDATE cookie_identity.telegram_identity_links
            SET revoked_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantB, linkB],
      );
      const again = await sessions.exchangeTelegramInitData(signed(TELEGRAM_ID));
      assert.ok(again);
      assert.equal((await sessions.verifyBearerToken(again.bearerToken))?.tenantId, tenantA);

      await pool.query(
        `UPDATE cookie_identity.telegram_identity_links
            SET revoked_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantA, linkA],
      );
      assert.equal(await sessions.verifyBearerToken(first.bearerToken), null);
      assert.equal(await sessions.verifyBearerToken(again.bearerToken), null);
      assert.equal(await sessions.exchangeTelegramInitData(signed(TELEGRAM_ID)), null);

      const revokedCount = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM cookie_identity.opaque_sessions
          WHERE tenant_id=$1::uuid AND telegram_link_id=$2::uuid
            AND revoked_at IS NOT NULL`,
        [tenantA, linkA],
      );
      assert.equal(revokedCount.rows[0]?.n, 2);

      // A fresh, separately verified and consented link can be provisioned
      // by trusted control-plane action, but cannot resurrect old sessions.
      await insertLink(tenantA, identityA, linkNew);
      const replacement = await sessions.exchangeTelegramInitData(signed(TELEGRAM_ID));
      assert.ok(replacement);
      assert.ok(await sessions.verifyBearerToken(replacement.bearerToken));
      assert.equal(await sessions.verifyBearerToken(first.bearerToken), null);
      assert.equal(await sessions.verifyBearerToken(again.bearerToken), null);

      // Invalid proof never reaches resolver, even with a persisted link.
      assert.equal(
        await sessions.exchangeTelegramInitData(
          signed(TELEGRAM_ID).replace("279058397", "279058396"),
        ),
        null,
      );
    } finally {
      try {
        for (const tenantId of [tenantA, tenantB]) {
          await pool.query(
            "DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1::uuid",
            [tenantId],
          );
          await pool.query(
            "DELETE FROM cookie_identity.telegram_identity_links WHERE tenant_id=$1::uuid",
            [tenantId],
          );
          await pool.query(
            "DELETE FROM cookie_identity.memberships WHERE tenant_id=$1::uuid",
            [tenantId],
          );
          await pool.query(
            "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
            [tenantId],
          );
        }
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid OR id=$2::uuid",
          [identityA, identityB],
        );
      } finally {
        await pool.end();
      }
    }
  },
);

test("trusted Telegram link resolver requires strong independent HMAC key and verified channel ID", async () => {
  assert.throws(
    () => createPostgresVerifiedTelegramLinkResolver({ userHashSecret: Buffer.alloc(16) }),
    /256-bit secret/,
  );
  const secret = Buffer.alloc(32, 44);
  const resolver = createPostgresVerifiedTelegramLinkResolver({ userHashSecret: secret });
  secret.fill(1);
  let calls = 0;
  const fakeClient = {
    async query() {
      calls++;
      return { rows: [] };
    },
  };
  const validProof = {
    channel: "telegram-mini-app" as const,
    telegramUserId: "279058397",
    authDateUnixSeconds: 1_794_830_400,
  };
  assert.equal(await resolver(fakeClient as never, { ...validProof, telegramUserId: "0" }), null);
  assert.equal(await resolver(fakeClient as never, { ...validProof, telegramUserId: "9007199254740993" }), null);
  assert.equal(await resolver(fakeClient as never, validProof), null);
  assert.equal(calls, 1);
});
