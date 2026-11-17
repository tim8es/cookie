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
    const address = randomUUID() + "@example.invalid";
    const fingerprint = emailFingerprint(secret, address);
    const messages: AuthMailMessage[] = [];
    const config = {
      transaction,
      fingerprintSecret: secret,
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
      await mailer.deliver("password-recovery", address);
      assert.equal(messages.length, 0);
      const rejecting = <T>(
        work: Parameters<typeof runSqlTransaction<T>>[1],
      ) =>
        runSqlTransaction(pool, async (client) => {
          await work(client);
          throw new Error("synthetic rollback");
        });
      const rejectedMailer = createEmailChallengeMailer({
        ...config,
        transaction: rejecting,
      });
      await assert.rejects(
        rejectedMailer.deliver("registration", address),
        /synthetic rollback/,
      );
      assert.equal(messages.length, 0);

      await mailer.deliver("registration", address);
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

      await mailer.deliver("password-recovery", address);
      assert.equal(messages.length, 2);
      assert.equal(messages[1]?.purpose, "password-recovery");
      assert.equal(messages[1]?.recipient, address);
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
