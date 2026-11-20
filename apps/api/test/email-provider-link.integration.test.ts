import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  completeEmailCredentialLink,
  createAuthMailQueue,
  createAuthMailWorker,
  exchangeTrustedTelegramUser,
  IdentitySessions,
  loginEmailPassword,
  PasswordWorkGate,
  type AuthMailLimits,
  type AuthMailLinkConfig,
  type EmailLoginLimits,
} from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

function admissionHash(secret: Buffer, scope: string, value: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update("cookie-auth-mail-admission-v1\0", "utf8")
    .update(scope, "utf8")
    .update("\0", "utf8")
    .update(value)
    .digest();
}

test(
  "email provider linking requires the same live Identity and allows email login afterward",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
    });
    const fingerprintSecret = randomBytes(32);
    const admissionSecret = randomBytes(32);
    const encryptionKey = randomBytes(32);
    const address = `synthetic-link-${randomBytes(8).toString("hex")}@example.invalid`;
    const telegramId = () =>
      String(Date.now() * 10 + Math.floor(Math.random() * 10));
    const loginLimits: EmailLoginLimits = {
      windowSeconds: 900,
      accountAttempts: 5,
      sourceAttempts: 20,
    };
    const mailLimits: AuthMailLimits = { ...loginLimits, globalAttempts: 100 };
    const transaction: Transaction = (work) => runSqlTransaction(pool, work);
    const queue = createAuthMailQueue({
      transaction,
      fingerprintSecret,
      admissionSecret,
      encryptionKey,
      limits: mailLimits,
      queueTtlSeconds: 3600,
      leaseSeconds: 30,
      dispatchSeconds: 60,
    });
    const links: AuthMailLinkConfig = {
      publicOrigin: "https://cookie.example.invalid",
      registrationPath: "/register",
      recoveryPath: "/recover",
      emailLinkPath: "/link-email",
    };
    const delivered: Array<{ purpose: string; confirmationUrl: string }> = [];
    const worker = createAuthMailWorker({
      queue,
      transaction,
      fingerprintSecret,
      links,
      transport: {
        deliver: async (message: {
          purpose: string;
          confirmationUrl: string;
        }) => {
          delivered.push(message);
        },
      },
      registrationTtlSeconds: 900,
      recoveryTtlSeconds: 900,
    });
    const emailSessions = new IdentitySessions(
      pool,
      "cookie-email",
      "cookie-web",
      900,
    );
    const telegramSessions = new IdentitySessions(
      pool,
      "cookie-telegram",
      "cookie-web",
      900,
    );
    const providers = [emailSessions, telegramSessions];
    const passwordWork = new PasswordWorkGate(1);
    const linkedPassword = "secure test password 2026";
    const app = createApp(pool, {
      emailIdentityRoutes: {
        sourceFingerprintSecret: admissionSecret,
        identitySessionProviders: providers,
        enqueueMail: (purpose, email, source) =>
          queue.enqueue(purpose, email, source),
        enqueueEmailLink: (identityId, email, source) =>
          queue.enqueue("email-link", email, source, identityId),
        completeRegistration: async () => null,
        completePasswordRecovery: async () => false,
        login: (email, password, sourceFingerprint) =>
          loginEmailPassword(
            transaction,
            passwordWork,
            fingerprintSecret,
            email,
            password,
            emailSessions,
            loginLimits,
            sourceFingerprint,
          ),
        completeEmailLink: (token, password, bearer, sessionProviders) =>
          completeEmailCredentialLink(
            transaction,
            passwordWork,
            fingerprintSecret,
            sessionProviders,
            bearer,
            token,
            password,
          ),
      },
      identitySessionProviders: providers,
      identitySessionPool: pool,
    });

    const cleanup: { jobStart?: Date } = {};
    const identityIds: string[] = [];
    const budgetHashes: Buffer[] = [];
    const sourceIp = "198.51.100.84";
    const source = createHmac("sha256", admissionSecret)
      .update("cookie-auth-source-v1\0", "utf8")
      .update(sourceIp, "utf8")
      .digest();
    const emailHash = createHmac("sha256", fingerprintSecret)
      .update("cookie-email-address-v1\0", "utf8")
      .update(address, "utf8")
      .digest();
    budgetHashes.push(
      source,
      emailHash,
      admissionHash(admissionSecret, "global", Buffer.alloc(0)),
      admissionHash(admissionSecret, "source", source),
      admissionHash(admissionSecret, "recipient", emailHash),
    );
    t.after(async () => {
      await app.close();
      if (cleanup.jobStart) {
        const jobs = await pool.query<{ id: string }>(
          "SELECT id::text FROM cookie_identity.auth_mail_jobs WHERE created_at >= $1::timestamptz",
          [cleanup.jobStart],
        );
        await pool.query(
          "DELETE FROM cookie_identity.auth_security_events WHERE mail_job_id=ANY($1::uuid[])",
          [jobs.rows.map((row) => row.id)],
        );
        await pool.query(
          "DELETE FROM cookie_identity.auth_mail_jobs WHERE id=ANY($1::uuid[])",
          [jobs.rows.map((row) => row.id)],
        );
      }
      await pool.query(
        "DELETE FROM cookie_identity.email_login_attempts WHERE subject_hmac_sha256=ANY($1::bytea[])",
        [budgetHashes],
      );
      if (identityIds.length) {
        await pool.query(
          "DELETE FROM cookie_identity.email_registration_challenges WHERE target_identity_id=ANY($1::uuid[])",
          [identityIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.auth_security_events WHERE identity_id=ANY($1::uuid[])",
          [identityIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.email_credentials WHERE identity_id=ANY($1::uuid[])",
          [identityIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=ANY($1::uuid[])",
          [identityIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_exchanges WHERE identity_id=ANY($1::uuid[])",
          [identityIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.global_telegram_identities WHERE identity_id=ANY($1::uuid[])",
          [identityIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [identityIds],
        );
      }
      await pool.end();
    });

    await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
    cleanup.jobStart = (
      await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now;
    const telegram = await exchangeTrustedTelegramUser(
      transaction,
      fingerprintSecret,
      telegramId(),
      randomBytes(32),
      true,
      900,
    );
    const otherTelegram = await exchangeTrustedTelegramUser(
      transaction,
      fingerprintSecret,
      telegramId(),
      randomBytes(32),
      true,
      900,
    );
    assert.ok(telegram);
    assert.ok(otherTelegram);
    const identityId = await telegramSessions.resolve(telegram.token);
    const otherIdentityId = await telegramSessions.resolve(otherTelegram.token);
    assert.ok(identityId);
    assert.ok(otherIdentityId);
    identityIds.push(identityId, otherIdentityId);

    const initialProviders = await app.inject({
      method: "GET",
      url: "/v1/auth/identity/providers",
      headers: { authorization: `Bearer ${telegram.token}` },
    });
    assert.equal(initialProviders.statusCode, 200);
    assert.deepEqual(initialProviders.json(), {
      providers: { email: false, telegram: true },
    });

    const requested = await app.inject({
      method: "POST",
      url: "/v1/auth/email/link/request",
      headers: { authorization: `Bearer ${telegram.token}` },
      payload: { email: address },
      remoteAddress: sourceIp,
    });
    assert.equal(requested.statusCode, 202);
    assert.deepEqual(requested.json(), { accepted: true });
    assert.equal(await worker.runOnce(), "submitted");
    const linkUrl = new URL(delivered[0]!.confirmationUrl);
    const proof = new URLSearchParams(linkUrl.hash.slice(1)).get("token");
    assert.equal(delivered[0]!.purpose, "email-link");
    assert.ok(proof);

    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/auth/email/link/complete",
      headers: { authorization: `Bearer ${otherTelegram.token}` },
      payload: { token: proof, password: linkedPassword },
    });
    assert.equal(mismatch.statusCode, 400);

    const linked = await app.inject({
      method: "POST",
      url: "/v1/auth/email/link/complete",
      headers: { authorization: `Bearer ${telegram.token}` },
      payload: { token: proof, password: linkedPassword },
    });
    assert.equal(linked.statusCode, 204);

    const providersAfter = await app.inject({
      method: "GET",
      url: "/v1/auth/identity/providers",
      headers: { authorization: `Bearer ${telegram.token}` },
    });
    assert.equal(providersAfter.statusCode, 200);
    assert.deepEqual(providersAfter.json(), {
      providers: { email: true, telegram: true },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/email/link/complete",
      headers: { authorization: `Bearer ${telegram.token}` },
      payload: { token: proof, password: linkedPassword },
    });
    assert.equal(replay.statusCode, 400);

    const emailLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/email/login",
      payload: { email: address, password: linkedPassword },
      remoteAddress: sourceIp,
    });
    assert.equal(emailLogin.statusCode, 200);
    assert.equal(
      await emailSessions.resolve(emailLogin.json().accessToken),
      identityId,
    );
  },
);
