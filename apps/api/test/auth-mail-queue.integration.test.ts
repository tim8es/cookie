import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import type { AuthMailMessage } from "../../../packages/platform-identity/src/auth-mail-delivery.js";
import { createAuthMailQueue } from "../../../packages/platform-identity/src/auth-mail-queue.js";
import { createAuthMailWorker } from "../../../packages/platform-identity/src/auth-mail-worker.js";
import { emailFingerprint } from "../../../packages/platform-identity/src/email-registration.js";

test(
  "auth mail queue fences claims and never retries ambiguous dispatch",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const tx = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const fingerprintSecret = randomBytes(32);
    const source = randomBytes(32);
    const email = randomUUID() + "@example.invalid";
    const config = {
      transaction: tx,
      fingerprintSecret,
      admissionSecret: randomBytes(32),
      encryptionKey: randomBytes(32),
      limits: {
        windowSeconds: 3600,
        accountAttempts: 20,
        sourceAttempts: 20,
        globalAttempts: 20,
      },
      queueTtlSeconds: 600,
      leaseSeconds: 60,
      dispatchSeconds: 120,
    };
    const queue = createAuthMailQueue(config);
    const jobs: string[] = [];
    const fingerprint = emailFingerprint(fingerprintSecret, email);
    const enqueue = async (purpose: AuthMailMessage["purpose"]) => {
      await queue.enqueue(purpose, email, source);
      const pending = await pool.query<{ id: string }>(
        "SELECT id::text FROM cookie_identity.auth_mail_jobs WHERE status='pending'",
      );
      assert.equal(pending.rowCount, 1);
      jobs.push(pending.rows[0]!.id);
    };
    const messages: AuthMailMessage[] = [];
    let failTransport = false;
    const worker = createAuthMailWorker({
      queue,
      transaction: tx,
      fingerprintSecret,
      links: {
        publicOrigin: "https://kuki.example.invalid",
        registrationPath: "/auth/confirm",
        recoveryPath: "/auth/recover",
      },
      registrationTtlSeconds: 300,
      recoveryTtlSeconds: 300,
      transport: {
        async deliver(message) {
          messages.push(message);
          if (failTransport) throw new Error("synthetic ambiguous outcome");
        },
      },
    });

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      type Work<T> = Parameters<typeof runSqlTransaction<T>>[1];
      const rollback = <T>(work: Work<T>) =>
        runSqlTransaction(pool, async (client) => {
          await work(client);
          throw new Error("synthetic enqueue rollback");
        });
      const rejected = createAuthMailQueue({
        ...config,
        transaction: rollback,
      });
      await assert.rejects(
        rejected.enqueue("registration", email, source),
        /synthetic enqueue rollback/,
      );
      assert.equal(await queue.claim(), null);

      await enqueue("registration");
      const claims = await Promise.all([queue.claim(), queue.claim()]);
      assert.equal(claims.filter(Boolean).length, 1);
      const first = claims.find(Boolean);
      assert.ok(first);
      const stored = await pool.query(
        "SELECT sealed_recipient FROM cookie_identity.auth_mail_jobs WHERE id=$1",
        [first.id],
      );
      const sealed: Buffer = stored.rows[0]?.sealed_recipient;
      assert.ok(Buffer.isBuffer(sealed));
      assert.equal(sealed.includes(Buffer.from(email)), false);

      await pool.query(
        "UPDATE cookie_identity.auth_mail_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [first.id],
      );
      const reclaimed = await queue.claim();
      assert.ok(reclaimed);
      assert.equal(reclaimed.id, first.id);
      assert.notEqual(reclaimed.lease_token, first.lease_token);
      assert.equal(await queue.start(first), null);
      assert.deepEqual(await queue.start(reclaimed), {
        purpose: "registration",
        address: email,
      });
      assert.equal(await queue.start(reclaimed), null);

      await pool.query(
        "UPDATE cookie_identity.auth_mail_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [first.id],
      );
      await queue.sweep(100);
      assert.equal(await queue.finish(reclaimed, "submitted"), false);
      const outcome = await pool.query(
        "SELECT status,sealed_recipient FROM cookie_identity.auth_mail_jobs WHERE id=$1",
        [first.id],
      );
      assert.deepEqual(outcome.rows[0], {
        status: "unknown",
        sealed_recipient: null,
      });
      assert.equal(await queue.claim(), null);

      await enqueue("registration");
      assert.equal(await worker.runOnce(), "submitted");
      assert.equal(messages.length, 1);
      await enqueue("password-recovery");
      assert.equal(await worker.runOnce(), "skipped");
      assert.equal(messages.length, 1);

      failTransport = true;
      await enqueue("registration");
      assert.equal(await worker.runOnce(), "unknown");
      assert.equal(await worker.runOnce(), "idle");
      assert.equal(messages.length, 2);

      await enqueue("registration");
      const expiredId = jobs.at(-1);
      await pool.query(
        "UPDATE cookie_identity.auth_mail_jobs SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
        [expiredId],
      );
      await queue.sweep(100);
      assert.equal(await queue.claim(), null);
      const expired = await pool.query(
        "SELECT status,sealed_recipient FROM cookie_identity.auth_mail_jobs WHERE id=$1",
        [expiredId],
      );
      assert.deepEqual(expired.rows[0], {
        status: "expired",
        sealed_recipient: null,
      });
      assert.ok(await queue.purge(100, 60));
      const audit = await pool.query<{ event_type: string }>(
        "SELECT event_type FROM cookie_identity.auth_security_events WHERE mail_job_id=ANY($1::uuid[]) ORDER BY id",
        [jobs],
      );
      assert.deepEqual(
        audit.rows.map((row) => row.event_type),
        [
          "mail_unknown",
          "mail_submitted",
          "mail_skipped",
          "mail_unknown",
          "mail_expired",
        ],
      );
    } finally {
      // Tests run serially on an isolated synthetic CI database.
      try {
        await pool.query(
          "DELETE FROM cookie_identity.auth_security_events WHERE mail_job_id=ANY($1::uuid[])",
          [jobs],
        );
        await pool.query(
          "DELETE FROM cookie_identity.auth_mail_jobs WHERE id=ANY($1::uuid[])",
          [jobs],
        );
        await pool.query(
          "DELETE FROM cookie_identity.email_registration_challenges WHERE email_hmac_sha256=$1",
          [fingerprint],
        );
        const derive = (scope: string, subject: Buffer) =>
          createHmac("sha256", config.admissionSecret)
            .update("cookie-auth-mail-admission-v1\0", "utf8")
            .update(scope, "utf8")
            .update("\0", "utf8")
            .update(subject)
            .digest();
        for (const key of [
          derive("global", Buffer.alloc(0)),
          derive("source", source),
          derive("recipient", fingerprint),
        ]) {
          await pool.query(
            "DELETE FROM cookie_identity.email_login_attempts WHERE subject_hmac_sha256=$1",
            [key],
          );
        }
      } finally {
        await pool.end();
      }
    }
  },
);
