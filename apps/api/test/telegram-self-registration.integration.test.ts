import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { provisionStagingCustomer } from "../../../packages/domain-customers/src/staging-customer.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/identity-sessions.js";
import { linkVerifiedTelegramOwner } from "../../../packages/platform-identity/src/link-telegram-owner.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { provisionOwnerWorkspace } from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";
import {
  createPostgresVerifiedTelegramLinkResolver,
  lockTelegramUser,
  telegramUserFingerprint,
} from "../../../packages/platform-identity/src/telegram-links.js";
import { exchangeSelfServiceTelegram } from "../../../packages/platform-identity/src/telegram-self-registration.js";

const TEST_BOT = "123456789:synthetic_NOT_A_REAL_BOT_TOKEN";

function signedInitData(bot: string, userId: number): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: randomUUID(),
    user: JSON.stringify({ id: userId }),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(bot).digest();
  return new URLSearchParams({
    ...fields,
    hash: createHmac("sha256", secret).update(check).digest("hex"),
  }).toString();
}

async function waitForAdvisoryWaiters(
  pool: Pool,
  fingerprint: Buffer,
  expected: number,
): Promise<void> {
  const key = BigInt.asUintN(64, fingerprint.readBigInt64BE(0));
  const high = (key >> 32n).toString();
  const low = (key & 0xffff_ffffn).toString();
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype='advisory' AND NOT granted
          AND classid=$1::oid AND objid=$2::oid AND objsubid=1`,
      [high, low],
    );
    if (result.rows[0]?.count === expected) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Expected ${expected} Telegram identity lock waiters`);
}

test(
  "verified Telegram self-registration is atomic, one-time and tenant independent",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
    const bot = TEST_BOT;
    const secret = Buffer.alloc(32, 35);
    const user = randomInt(100000000, 999999999);
    const fingerprint = telegramUserFingerprint(secret, String(user));
    const verifier = createTelegramMiniAppProofVerifier({
      botToken: bot,
      maxAgeSeconds: 300,
    });
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const proof = () => {
      const data = {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: randomUUID(),
        user: JSON.stringify({ id: user }),
      };
      const check = Object.entries(data)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      const key = createHmac("sha256", "WebAppData").update(bot).digest();
      return new URLSearchParams({
        ...data,
        hash: createHmac("sha256", key).update(check).digest("hex"),
      }).toString();
    };
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      assert.equal(
        await exchangeSelfServiceTelegram(
          transaction,
          verifier,
          secret,
          proof(),
          false,
          900,
        ),
        null,
      );
      assert.equal(
        await exchangeSelfServiceTelegram(
          transaction,
          verifier,
          secret,
          "hash=bad",
          true,
          900,
        ),
        null,
      );
      const signed = proof();
      const attempts = await Promise.all(
        [1, 2].map(() =>
          exchangeSelfServiceTelegram(
            transaction,
            verifier,
            secret,
            signed,
            true,
            900,
          ),
        ),
      );
      const issued = attempts.filter((x) => x !== null);
      assert.equal(issued.length, 1);
      const sessions = new IdentitySessions(
        pool,
        "cookie-telegram",
        "cookie-web",
        900,
      );
      const id = await sessions.resolve(issued[0]!.token);
      assert.ok(id);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.memberships WHERE identity_id=$1::uuid",
            [id],
          )
        ).rowCount,
        0,
      );
      const again = await exchangeSelfServiceTelegram(
        transaction,
        verifier,
        secret,
        proof(),
        false,
        900,
      );
      assert.ok(again);
      assert.equal(await sessions.resolve(again.token), id);
      assert.equal(
        (
          await pool.query(
            "SELECT identity_id FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1",
            [fingerprint],
          )
        ).rowCount,
        1,
      );
    } finally {
      const rows = await pool.query<{ identity_id: string }>(
        "SELECT identity_id::text FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1",
        [fingerprint],
      );
      const id = rows.rows[0]?.identity_id;
      if (id) {
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_exchanges WHERE identity_id=$1::uuid",
          [id],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
          [id],
        );
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_identities WHERE identity_id=$1::uuid",
          [id],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [id],
        );
      }
      await pool.end();
    }
  },
);

test(
  "legacy and global Telegram auth paths serialize proof reuse and account linking",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
    });
    const secret = Buffer.alloc(32, 0x5a);
    const verifier = createTelegramMiniAppProofVerifier({
      botToken: TEST_BOT,
      maxAgeSeconds: 300,
    });
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const ownerIdentityId = randomUUID();
    let tenantId: string | undefined;
    const legacyUser = randomInt(100000000, 999999999);
    const linkRaceUser = randomInt(100000000, 999999999);
    const legacyFingerprint = telegramUserFingerprint(
      secret,
      String(legacyUser),
    );
    const linkRaceFingerprint = telegramUserFingerprint(
      secret,
      String(linkRaceUser),
    );
    let customerIdentityId: string | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1)",
        [ownerIdentityId],
      );
      const workspace = await provisionOwnerWorkspace(pool, {
        ownerIdentityId,
        idempotencyKey: "telegram-auth-lock-" + randomUUID(),
        organizationName: "Synthetic Telegram lock test",
        locationName: "Main",
        timeZone: "Europe/Moscow",
      });
      tenantId = workspace.tenantId;
      const rawLegacy = signedInitData(TEST_BOT, legacyUser);
      await provisionStagingCustomer(pool, verifier, secret, {
        tenantId,
        rawInitData: rawLegacy,
        consentConfirmed: true,
      });
      const legacySessions = new PostgresOpaqueTelegramSessions({
        pool,
        telegramProofVerifier: verifier,
        fingerprintSecret: secret,
        resolveVerifiedTelegramLink: createPostgresVerifiedTelegramLinkResolver(
          {
            userHashSecret: secret,
          },
        ),
        issuer: "cookie-telegram",
        audience: "cookie-web",
        ttlSeconds: 900,
      });

      const legacyLock = await pool.connect();
      await legacyLock.query("BEGIN");
      await lockTelegramUser(legacyLock, secret, String(legacyUser));
      const globalLogin = exchangeSelfServiceTelegram(
        transaction,
        verifier,
        secret,
        rawLegacy,
        true,
        900,
      );
      const legacyLogin = legacySessions.exchangeTelegramInitData(rawLegacy);
      try {
        await waitForAdvisoryWaiters(pool, legacyFingerprint, 2);
      } finally {
        await legacyLock.query("COMMIT");
        legacyLock.release();
      }
      const [globalResult, legacyResult] = await Promise.all([
        globalLogin,
        legacyLogin,
      ]);
      assert.equal(globalResult, null);
      assert.ok(legacyResult);

      const rawLinkRace = signedInitData(TEST_BOT, linkRaceUser);
      const linkLock = await pool.connect();
      await linkLock.query("BEGIN");
      await lockTelegramUser(linkLock, secret, String(linkRaceUser));
      const register = exchangeSelfServiceTelegram(
        transaction,
        verifier,
        secret,
        rawLinkRace,
        true,
        900,
      );
      const ownerLink = linkVerifiedTelegramOwner(pool, verifier, secret, {
        tenantId,
        ownerIdentityId,
        rawInitData: rawLinkRace,
        consentConfirmed: true,
      });
      try {
        await waitForAdvisoryWaiters(pool, linkRaceFingerprint, 2);
      } finally {
        await linkLock.query("COMMIT");
        linkLock.release();
      }
      const [registrationResult, ownerLinkResult] = await Promise.allSettled([
        register,
        ownerLink,
      ]);
      const globalIdentity = await pool.query<{ identity_id: string }>(
        "SELECT identity_id::text FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1::bytea",
        [linkRaceFingerprint],
      );
      const trustedLink = await pool.query(
        "SELECT 1 FROM cookie_identity.telegram_identity_links WHERE telegram_user_hmac_sha256=$1::bytea AND revoked_at IS NULL",
        [linkRaceFingerprint],
      );
      assert.equal(
        (globalIdentity.rowCount ?? 0) + (trustedLink.rowCount ?? 0),
        1,
      );
      if ((globalIdentity.rowCount ?? 0) === 1) {
        assert.equal(registrationResult.status, "fulfilled");
        assert.ok(registrationResult.value);
        assert.equal(ownerLinkResult.status, "rejected");
      } else {
        assert.equal(registrationResult.status, "fulfilled");
        assert.equal(registrationResult.value, null);
        assert.equal(ownerLinkResult.status, "fulfilled");
      }
    } finally {
      if (tenantId) {
        const customers = await pool.query<{ identity_id: string }>(
          "SELECT identity_id::text FROM cookie_customers.staging_customer_identities WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        customerIdentityId = customers.rows[0]?.identity_id;
        await pool.query(
          "DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_customers.staging_customer_identities WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_customers.customers WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.telegram_identity_links WHERE tenant_id=$1::uuid",
          [tenantId],
        );
      }
      const globalIdentities = await pool.query<{ identity_id: string }>(
        `SELECT identity_id::text FROM cookie_identity.global_telegram_identities
          WHERE telegram_user_hmac_sha256 IN ($1::bytea,$2::bytea)`,
        [legacyFingerprint, linkRaceFingerprint],
      );
      const globalIds = globalIdentities.rows.map((row) => row.identity_id);
      if (globalIds.length) {
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_exchanges WHERE identity_id=ANY($1::uuid[])",
          [globalIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=ANY($1::uuid[])",
          [globalIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_identities WHERE identity_id=ANY($1::uuid[])",
          [globalIds],
        );
      }
      if (tenantId) {
        await pool.query(
          "DELETE FROM cookie_tenancy.owner_setup_receipts WHERE owner_identity_id=$1::uuid",
          [ownerIdentityId],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenantId],
        );
      }
      const identities = [
        ownerIdentityId,
        customerIdentityId,
        ...globalIds,
      ].filter((id): id is string => Boolean(id));
      if (identities.length) {
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [identities],
        );
      }
      await pool.end();
    }
  },
);
