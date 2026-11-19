import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  completeEmailPasswordRecovery,
  completeEmailRegistration,
  createAuthMailQueue,
  createAuthMailWorker,
  IdentitySessions,
  loginEmailPassword,
  PasswordWorkGate,
  type AuthMailLimits,
  type AuthMailLinkConfig,
  type EmailLoginLimits,
} from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

function derive(secret: Buffer, scope: string, subject: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update("cookie-auth-mail-admission-v1\0", "utf8")
    .update(scope, "utf8")
    .update("\0", "utf8")
    .update(subject)
    .digest();
}

test(
  "real email API completes registration, login, recovery, session and logout against PostgreSQL",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
    const fingerprintSecret = randomBytes(32);
    const admissionSecret = randomBytes(32);
    const encryptionKey = randomBytes(32);
    const address = "synthetic-client@example.invalid";
    const loginLimits: EmailLoginLimits = {
      windowSeconds: 900,
      accountAttempts: 5,
      sourceAttempts: 20,
    };
    const mailLimits: AuthMailLimits = {
      ...loginLimits,
      globalAttempts: 100,
    };
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
    };
    const delivered: Array<{ purpose: string; confirmationUrl: string }> = [];
    const transport = {
      deliver: async (message: {
        purpose: string;
        confirmationUrl: string;
      }) => {
        delivered.push(message);
      },
    };
    const registrationTtlSeconds = 900;
    const recoveryTtlSeconds = 900;
    const worker = createAuthMailWorker({
      queue,
      transaction,
      fingerprintSecret,
      links,
      transport,
      registrationTtlSeconds,
      recoveryTtlSeconds,
    });
    const sessions = new IdentitySessions(pool, "email-api-test", "web", 900);
    const passwordWork = new PasswordWorkGate(1);
    const app = createApp(pool, {
      emailIdentityRoutes: {
        sourceFingerprintSecret: admissionSecret,
        enqueueMail: (purpose, email, source) =>
          queue.enqueue(purpose, email, source),
        completeRegistration: (token, password) =>
          completeEmailRegistration(transaction, passwordWork, token, password),
        login: (email, password, source) =>
          loginEmailPassword(
            transaction,
            passwordWork,
            fingerprintSecret,
            email,
            password,
            sessions,
            loginLimits,
            source,
          ),
        completePasswordRecovery: (token, password) =>
          completeEmailPasswordRecovery(
            transaction,
            passwordWork,
            token,
            password,
          ),
      },
      identitySessionProviders: [sessions],
      identitySessionPool: pool,
    });
    const cleanup: { identityId?: string; jobStart?: Date } = {};
    const sourceIp = "198.51.100.42";
    const source = createHmac("sha256", admissionSecret)
      .update("cookie-auth-source-v1\0", "utf8")
      .update(sourceIp, "utf8")
      .digest();
    const emailHash = createHmac("sha256", fingerprintSecret)
      .update("cookie-email-address-v1\0", "utf8")
      .update(address, "utf8")
      .digest();
    const budgetHashes = [
      source,
      emailHash,
      derive(admissionSecret, "global", Buffer.alloc(0)),
      derive(admissionSecret, "source", source),
      derive(admissionSecret, "recipient", emailHash),
    ];
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
      if (cleanup.identityId) {
        await pool.query(
          "DELETE FROM cookie_identity.auth_security_events WHERE identity_id=$1::uuid",
          [cleanup.identityId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.email_credentials WHERE identity_id=$1::uuid",
          [cleanup.identityId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
          [cleanup.identityId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [cleanup.identityId],
        );
      }
      await pool.end();
    });

    await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
    cleanup.jobStart = (
      await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now;
    const requested = await app.inject({
      method: "POST",
      url: "/v1/auth/email/registration/request",
      payload: { email: address },
      remoteAddress: sourceIp,
    });
    assert.equal(requested.statusCode, 202);
    assert.deepEqual(requested.json(), { accepted: true });
    assert.equal(await worker.runOnce(), "submitted");
    const registrationUrl = new URL(delivered[0]!.confirmationUrl);
    const registrationToken = new URLSearchParams(
      registrationUrl.hash.slice(1),
    ).get("token");
    assert.equal(delivered[0]!.purpose, "registration");
    assert.ok(registrationToken);

    const password = "correct horse battery staple 2026";
    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/email/registration/complete",
      payload: { token: registrationToken, password },
    });
    assert.equal(registered.statusCode, 201);
    assert.deepEqual(registered.json(), { registered: true });

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/email/login",
      payload: { email: address, password },
      remoteAddress: sourceIp,
    });
    assert.equal(login.statusCode, 200);
    const oldToken = login.json().accessToken as string;
    const identityId = (await sessions.resolve(oldToken)) ?? undefined;
    cleanup.identityId = identityId;
    assert.ok(identityId);
    const organizations = await app.inject({
      method: "GET",
      url: "/v1/auth/identity/organizations",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    assert.equal(organizations.statusCode, 200);
    assert.deepEqual(organizations.json(), { organizations: [] });
    const providers = await app.inject({
      method: "GET",
      url: "/v1/auth/identity/providers",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    assert.equal(providers.statusCode, 200);
    assert.deepEqual(providers.json(), {
      providers: { email: true, telegram: false },
    });

    const recoveryRequest = await app.inject({
      method: "POST",
      url: "/v1/auth/email/password-recovery/request",
      payload: { email: address },
      remoteAddress: sourceIp,
    });
    assert.equal(recoveryRequest.statusCode, 202);
    assert.deepEqual(recoveryRequest.json(), { accepted: true });
    assert.equal(await worker.runOnce(), "submitted");
    const recoveryUrl = new URL(delivered[1]!.confirmationUrl);
    const recoveryToken = new URLSearchParams(recoveryUrl.hash.slice(1)).get(
      "token",
    );
    assert.equal(delivered[1]!.purpose, "password-recovery");
    assert.ok(recoveryToken);

    const newPassword = "another secure passphrase for staging";
    const recovered = await app.inject({
      method: "POST",
      url: "/v1/auth/email/password-recovery/complete",
      payload: { token: recoveryToken, password: newPassword },
    });
    assert.equal(recovered.statusCode, 204);
    assert.equal(await sessions.resolve(oldToken), null);

    const newLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/email/login",
      payload: { email: address, password: newPassword },
      remoteAddress: sourceIp,
    });
    assert.equal(newLogin.statusCode, 200);
    const newToken = newLogin.json().accessToken as string;
    assert.equal(await sessions.resolve(newToken), identityId);
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/identity/logout",
      headers: { authorization: `Bearer ${newToken}` },
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(await sessions.resolve(newToken), null);

    const audit = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM cookie_identity.auth_security_events WHERE identity_id=$1::uuid ORDER BY id",
      [identityId],
    );
    assert.deepEqual(
      audit.rows.map((row) => row.event_type),
      [
        "email_registered",
        "email_login",
        "password_recovered",
        "email_login",
        "identity_session_revoked",
      ],
    );
  },
);
