import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import { withVerifiedEmailPassword } from "../../../packages/platform-identity/src/email-login.js";
import {
  completeEmailPasswordRecovery,
  issueEmailPasswordRecovery,
  purgeExpiredEmailRecoveryChallenges,
} from "../../../packages/platform-identity/src/email-password-recovery.js";
import {
  completeEmailRegistration,
  emailFingerprint,
  issueEmailRegistrationChallenge,
} from "../../../packages/platform-identity/src/email-registration.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/identity-sessions.js";
import { PasswordWorkGate } from "../../../packages/platform-identity/src/password-work-gate.js";

test(
  "password recovery consumes one generation, revokes sessions and rolls back",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
    });
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const secret = randomBytes(32);
    const email = randomUUID() + "@example.invalid";
    const fingerprint = emailFingerprint(secret, email);
    const original = "synthetic original password";
    const changed = "synthetic changed password";
    const gate = new PasswordWorkGate(2);
    const issuer = "cookie-email";
    const sessions = new IdentitySessions(pool, issuer, "test-web", 900);
    const otherId = randomUUID();
    let identityId: string | null = null;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const registration = await issueEmailRegistrationChallenge(
        transaction,
        secret,
        email,
        300,
      );
      assert.ok(registration);
      identityId = await completeEmailRegistration(
        transaction,
        gate,
        registration.token,
        original,
      );
      assert.ok(identityId);
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [otherId],
      );
      const previousSession = await sessions.issueForVerifiedIdentity(identityId);
      const unrelatedSession = await sessions.issueForVerifiedIdentity(otherId);

      const unknownEmail = randomUUID() + "@example.invalid";
      assert.equal(
        await issueEmailPasswordRecovery(
          transaction,
          secret,
          unknownEmail,
          300,
        ),
        null,
      );
      const issue = () =>
        issueEmailPasswordRecovery(transaction, secret, email, 300);
      const first = await issue();
      const second = await issue();
      assert.ok(first);
      assert.ok(second);

      let calls = 0;
      const rejectingTransaction = <T>(
        work: Parameters<typeof runSqlTransaction<T>>[1],
      ) =>
        runSqlTransaction(pool, async (client) => {
          const result = await work(client);
          calls++;
          if (calls === 2) throw new Error("recovery rollback");
          return result;
        });
      await assert.rejects(
        completeEmailPasswordRecovery(
          rejectingTransaction,
          gate,
          first.token,
          changed,
        ),
        /recovery rollback/,
      );
      assert.equal(calls, 2);
      assert.equal(await sessions.resolve(previousSession.token), identityId);

      const verify = (candidate: string) =>
        withVerifiedEmailPassword(
          transaction,
          gate,
          secret,
          email,
          candidate,
          async (_client, id) => id,
        );
      assert.equal(await verify(original), identityId);

      const results = await Promise.all([
        completeEmailPasswordRecovery(transaction, gate, first.token, changed),
        completeEmailPasswordRecovery(transaction, gate, second.token, changed),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(await verify(original), null);
      assert.equal(await verify(changed), identityId);
      assert.equal(await sessions.resolve(previousSession.token), null);
      assert.equal(await sessions.resolve(unrelatedSession.token), otherId);
      assert.equal(
        await completeEmailPasswordRecovery(
          transaction,
          gate,
          first.token,
          original,
        ),
        false,
      );
      assert.equal(
        await completeEmailPasswordRecovery(
          transaction,
          gate,
          registration.token,
          original,
        ),
        false,
      );

      const expired = await issue();
      assert.ok(expired);
      await pool.query(
        `UPDATE cookie_identity.email_password_recovery_challenges
         SET created_at=clock_timestamp()-interval '2 hours',
             expires_at=clock_timestamp()-interval '1 hour'
         WHERE email_hmac_sha256=$1`,
        [fingerprint],
      );
      assert.equal(
        await completeEmailPasswordRecovery(
          transaction,
          gate,
          expired.token,
          original,
        ),
        false,
      );
      assert.equal(await verify(changed), identityId);
      const purged = await purgeExpiredEmailRecoveryChallenges(transaction, 10000);
      assert.ok(purged > 0);
      const remaining = await pool.query(
        "SELECT 1 FROM cookie_identity.email_password_recovery_challenges WHERE email_hmac_sha256=$1",
        [fingerprint],
      );
      assert.equal(remaining.rowCount, 0);
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_identity.identity_sessions WHERE identity_id IN ($1::uuid,$2::uuid)",
          [identityId, otherId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.email_registration_challenges WHERE email_hmac_sha256=$1",
          [fingerprint],
        );
        await pool.query(
          "DELETE FROM cookie_identity.email_credentials WHERE email_hmac_sha256=$1",
          [fingerprint],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id IN ($1::uuid,$2::uuid)",
          [identityId, otherId],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
