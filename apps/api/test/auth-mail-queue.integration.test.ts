import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import type { AuthMailMessage } from "../../../packages/platform-identity/src/auth-mail-delivery.js";
import { createAuthMailQueue } from "../../../packages/platform-identity/src/auth-mail-queue.js";
import { createAuthMailWorker } from "../../../packages/platform-identity/src/auth-mail-worker.js";

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
      await queue.enqueue("registration", email, source);
      const first = await queue.claim();
      assert.ok(first);
      jobs.push(first.id);
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

      await queue.enqueue("registration", email, source);
      assert.equal(await worker.runOnce(), "submitted");
      assert.equal(messages.length, 1);
      await queue.enqueue("password-recovery", email, source);
      assert.equal(await worker.runOnce(), "skipped");
      assert.equal(messages.length, 1);

      failTransport = true;
      await queue.enqueue("registration", email, source);
      assert.equal(await worker.runOnce(), "unknown");
      assert.equal(await worker.runOnce(), "idle");
      assert.equal(messages.length, 2);
    } finally {
      // Tests run serially on an isolated synthetic CI database.
      await pool.query(
        "DELETE FROM cookie_identity.auth_mail_jobs WHERE id=ANY($1::uuid[])",
        [jobs],
      );
      await pool.end();
    }
  },
);
