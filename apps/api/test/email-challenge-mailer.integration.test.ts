import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import type { AuthMailMessage } from "../../../packages/platform-identity/src/auth-mail-delivery.js";
import { createEmailChallengeMailer } from "../../../packages/platform-identity/src/email-challenge-mailer.js";
import {
  completeEmailRegistration,
  emailFingerprint,
} from "../../../packages/platform-identity/src/email-registration.js";
import { PasswordWorkGate } from "../../../packages/platform-identity/src/password-work-gate.js";

test(
  "delivery receives only committed challenges and never sends after rollback",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 3,
    });
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const secret = randomBytes(32);
    const admissionSecret = randomBytes(32);
    const source = randomBytes(32);
    const address = randomUUID() + "@example.invalid";
    const fingerprint = emailFingerprint(secret, address);
    const messages: AuthMailMessage[] = [];
    const config = {
      transaction,
      fingerprintSecret: secret,
      admissionSecret,
      limits: {
        windowSeconds: 3600,
        accountAttempts: 4,
        sourceAttempts: 10,
        globalAttempts: 20,
      },
      links: {
        publicOrigin: "https://kuki.example.invalid",
        registrationPath: "/auth/confirm",
        recoveryPath: "/auth/recover",
      },
      registrationTtlSeconds: 300,
      recoveryTtlSeconds: 300,
      transport: {
        async deliver(message: AuthMailMessage) {
          const url = new URL(message.confirmationUrl);
          const token = new URLSearchParams(url.hash.slice(1)).get("token");
          assert.ok(token);
          const digest = createHash("sha256").update(token).digest();
          const statement =
            message.purpose === "registration"
              ? "SELECT 1 FROM cookie_identity.email_registration_challenges WHERE token_sha256=$1"
              : "SELECT 1 FROM cookie_identity.email_password_recovery_challenges WHERE token_sha256=$1";
          // This is a separate connection, so an uncommitted insert is invisible.
          const stored = await pool.query(statement, [digest]);
          assert.equal(stored.rowCount, 1);
          messages.push(message);
        },
      },
    };
    let identity: string | null = null;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const mailer = createEmailChallengeMailer(config);
      await mailer.deliver("password-recovery", address, source);
      assert.equal(messages.length, 0);
      type Work<T> = Parameters<typeof runSqlTransaction<T>>[1];
      let calls = 0;
      const rejecting = <T>(work: Work<T>) =>
        runSqlTransaction(pool, async (client) => {
          const result = await work(client);
          if (++calls === 2) throw new Error("synthetic rollback");
          return result;
        });
      const rejectedMailer = createEmailChallengeMailer({
        ...config,
        transaction: rejecting,
      });
      await assert.rejects(
        rejectedMailer.deliver("registration", address, source),
        /synthetic rollback/,
      );
      assert.equal(messages.length, 0);

      await mailer.deliver("registration", address, source);
      assert.equal(messages.length, 1);
      const url = new URL(messages[0]!.confirmationUrl);
      const token = new URLSearchParams(url.hash.slice(1)).get("token");
      identity = await completeEmailRegistration(
        transaction,
        new PasswordWorkGate(1),
        token,
        "synthetic password for delivery test",
      );
      assert.ok(identity);

      await mailer.deliver("password-recovery", address, source);
      assert.equal(messages.length, 2);
      assert.equal(messages[1]?.purpose, "password-recovery");
      assert.equal(messages[1]?.recipient, address);

      // Registration and recovery share the recipient budget, even when a
      // different trusted source requests another message.
      await mailer.deliver("registration", address, randomBytes(32));
      assert.equal(messages.length, 2);
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_identity.email_registration_challenges WHERE email_hmac_sha256=$1",
          [fingerprint],
        );
        await pool.query(
          "DELETE FROM cookie_identity.email_credentials WHERE email_hmac_sha256=$1",
          [fingerprint],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [identity],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
