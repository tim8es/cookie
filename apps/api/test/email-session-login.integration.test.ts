import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import {
  completeEmailRegistration,
  emailFingerprint,
  issueEmailRegistrationChallenge,
} from "../../../packages/platform-identity/src/email-registration.js";
import { loginEmailPassword } from "../../../packages/platform-identity/src/email-session-login.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/identity-sessions.js";
import { PasswordWorkGate } from "../../../packages/platform-identity/src/password-work-gate.js";

test(
  "email login issues a revocable session only after committed verification",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 2,
    });
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const secret = Buffer.alloc(32, 29);
    const email = randomUUID() + "@example.invalid";
    const fingerprint = emailFingerprint(secret, email);
    const password = "synthetic session password";
    const gate = new PasswordWorkGate(1);
    const sessions = new IdentitySessions(pool, "cookie-email", "cookie-web", 900);
    const otherAudience = new IdentitySessions(pool, "cookie-email", "other", 900);
    let identityId: string | null = null;
    const countSessions = async () =>
      (
        await pool.query(
          "SELECT 1 FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
          [identityId],
        )
      ).rowCount;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const challenge = await issueEmailRegistrationChallenge(
        transaction,
        secret,
        email,
        300,
      );
      assert.ok(challenge);
      identityId = await completeEmailRegistration(
        transaction,
        gate,
        challenge.token,
        password,
      );
      assert.ok(identityId);
      assert.equal(await countSessions(), 0);

      const login = (address: string, candidate: string) =>
        loginEmailPassword(
          transaction,
          gate,
          secret,
          address,
          candidate,
          sessions,
        );

      assert.equal(await login(email, "incorrect"), null);
      assert.equal(await login(randomUUID() + "@example.invalid", password), null);
      assert.equal(await countSessions(), 0);

      const session = await login(email, password);
      assert.ok(session);
      assert.match(session.token, /^is_[A-Za-z0-9_-]{43}$/);
      assert.equal(await sessions.resolve(session.token), identityId);
      assert.equal(await otherAudience.resolve(session.token), null);
      assert.equal(await countSessions(), 1);

      const stored = await pool.query(
        "SELECT token_sha256 FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
        [identityId],
      );
      assert.deepEqual(
        stored.rows[0]?.token_sha256,
        createHash("sha256").update(session.token).digest(),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.memberships WHERE identity_id=$1::uuid",
            [identityId],
          )
        ).rowCount,
        0,
      );

      let calls = 0;
      const rejectingTransaction = <T>(
        work: Parameters<typeof runSqlTransaction<T>>[1],
      ) =>
        runSqlTransaction(pool, async (client) => {
          const value = await work(client);
          calls += 1;
          if (calls === 2) throw new Error("synthetic rollback");
          return value;
        });
      await assert.rejects(
        loginEmailPassword(
          rejectingTransaction,
          gate,
          secret,
          email,
          password,
          sessions,
        ),
        /synthetic rollback/,
      );
      assert.equal(calls, 2);
      assert.equal(await countSessions(), 1);

      await sessions.revoke(session.token);
      assert.equal(await sessions.resolve(session.token), null);
    } finally {
      try {
        if (identityId) {
          await pool.query(
            "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
            [identityId],
          );
        }
        await pool.query(
          "DELETE FROM cookie_identity.email_registration_challenges WHERE email_hmac_sha256=$1",
          [fingerprint],
        );
        await pool.query(
          "DELETE FROM cookie_identity.email_credentials WHERE email_hmac_sha256=$1",
          [fingerprint],
        );
        if (identityId) {
          await pool.query(
            "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
            [identityId],
          );
        }
      } finally {
        await pool.end();
      }
    }
  },
);
