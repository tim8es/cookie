import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import {
  completeEmailRegistration,
  issueEmailRegistrationChallenge,
} from "../../../packages/platform-identity/src/email-registration.js";
import { verifyPassword } from "../../../packages/platform-identity/src/password-crypto.js";
import { PasswordWorkGate } from "../../../packages/platform-identity/src/password-work-gate.js";

test(
  "email registration consumes proof once and creates exactly one verified identity",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const email = randomUUID() + "@example.invalid";
    const secret = Buffer.alloc(32, 42);
    const fingerprint = createHmac("sha256", secret)
      .update("cookie-email-address-v1\0", "utf8")
      .update(email, "utf8")
      .digest();
    const expiredEmail = randomUUID() + "@example.invalid";
    const expiredFingerprint = createHmac("sha256", secret)
      .update("cookie-email-address-v1\0", "utf8")
      .update(expiredEmail, "utf8")
      .digest();
    const password = "synthetic registration password";
    const passwordWork = new PasswordWorkGate(2);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const first = await issueEmailRegistrationChallenge(
        transaction,
        secret,
        email,
        300,
      );
      const second = await issueEmailRegistrationChallenge(
        transaction,
        secret,
        email,
        300,
      );
      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.token, second.token);
      assert.equal(first.address, email);
      const stored = await pool.query(
        "SELECT token_sha256 FROM cookie_identity.email_registration_challenges WHERE email_hmac_sha256=$1",
        [fingerprint],
      );
      assert.equal(stored.rowCount, 2);
      assert.ok(
        stored.rows.some((row) =>
          (row.token_sha256 as Buffer).equals(
            createHash("sha256").update(first.token).digest(),
          ),
        ),
      );
      const results = await Promise.all([
        completeEmailRegistration(
          transaction,
          passwordWork,
          first.token,
          password,
        ),
        completeEmailRegistration(
          transaction,
          passwordWork,
          second.token,
          password,
        ),
      ]);
      const identities = results.filter((result) => result !== null);
      assert.equal(identities.length, 1);
      const identityId = identities[0]!;
      const credentials = await pool.query(
        "SELECT identity_id::text,password_hash FROM cookie_identity.email_credentials WHERE email_hmac_sha256=$1",
        [fingerprint],
      );
      assert.equal(credentials.rowCount, 1);
      assert.equal(credentials.rows[0]?.identity_id, identityId);
      assert.equal(
        await verifyPassword(password, credentials.rows[0]?.password_hash),
        true,
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
      assert.equal(
        await completeEmailRegistration(transaction, passwordWork, first.token, password),
        null,
      );
      assert.equal(
        await completeEmailRegistration(transaction, passwordWork, "invalid", password),
        null,
      );

      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.email_registration_challenges WHERE email_hmac_sha256=$1",
            [fingerprint],
          )
        ).rowCount,
        0,
      );

      const expired = await issueEmailRegistrationChallenge(
        transaction,
        secret,
        expiredEmail,
        300,
      );
      assert.ok(expired);
      await pool.query(
        "UPDATE cookie_identity.email_registration_challenges SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE email_hmac_sha256=$1",
        [expiredFingerprint],
      );
      assert.equal(
        await completeEmailRegistration(transaction, passwordWork, expired.token, password),
        null,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.email_credentials WHERE email_hmac_sha256=$1",
            [expiredFingerprint],
          )
        ).rowCount,
        0,
      );
    } finally {
      await pool.query(
        "DELETE FROM cookie_identity.email_registration_challenges WHERE email_hmac_sha256 IN ($1,$2)",
        [fingerprint, expiredFingerprint],
      );
      const removed = await pool.query<{ identity_id: string }>(
        "DELETE FROM cookie_identity.email_credentials WHERE email_hmac_sha256 IN ($1,$2) RETURNING identity_id::text",
        [fingerprint, expiredFingerprint],
      );
      for (const row of removed.rows) {
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [row.identity_id],
        );
      }
      await pool.end();
    }
  },
);
