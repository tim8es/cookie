import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import { createAuthMailAdmission } from "../../../packages/platform-identity/src/auth-mail-admission.js";
import { reserveEmailLoginAttempt } from "../../../packages/platform-identity/src/email-login-throttle.js";

test(
  "mail quotas are shared across sources and isolated from login",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 6,
    });
    const tx = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const secret = randomBytes(32);
    const recipient = randomBytes(32);
    const sources = Array.from({ length: 6 }, () => randomBytes(32));
    const limits = {
      windowSeconds: 3600,
      accountAttempts: 2,
      sourceAttempts: 1,
      globalAttempts: 8,
    };
    const config = { transaction: tx, namespaceSecret: secret, limits };
    const first = createAuthMailAdmission(config);
    const second = createAuthMailAdmission(config);
    const clean = (scope: string, subject: Buffer) =>
      createHmac("sha256", secret)
        .update("cookie-auth-mail-admission-v1\0", "utf8")
        .update(scope, "utf8")
        .update("\0", "utf8")
        .update(subject)
        .digest();
    const fingerprints = [
      clean("global", Buffer.alloc(0)),
      clean("recipient", recipient),
      ...sources.map((source) => clean("source", source)),
      ...sources,
      recipient,
    ];

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const results = await Promise.all(
        sources.map((source, i) =>
          (i % 2 === 0 ? first : second).reserve(source, recipient),
        ),
      );
      assert.equal(results.filter(Boolean).length, 2);

      // A source already at capacity cannot request another recipient.
      const freshRecipient = randomBytes(32);
      fingerprints.push(clean("recipient", freshRecipient));
      assert.equal(await first.reserve(sources[0]!, freshRecipient), false);

      // Global attempt number eight may be admitted for a new source.
      const freshSource = randomBytes(32);
      fingerprints.push(clean("source", freshSource));
      assert.equal(await second.reserve(freshSource, freshRecipient), true);

      // A ninth attempt from any source is rejected even if recipient is new.
      const finalSource = randomBytes(32);
      fingerprints.push(clean("source", finalSource));
      assert.equal(await first.reserve(finalSource, null), false);

      // Mail source and recipient use different keys than login budgets.
      assert.equal(
        await reserveEmailLoginAttempt(tx, limits, sources[0]!, recipient),
        true,
      );
    } finally {
      try {
        for (const fingerprint of fingerprints) {
          await pool.query(
            "DELETE FROM cookie_identity.email_login_attempts WHERE subject_hmac_sha256=$1",
            [fingerprint],
          );
        }
      } finally {
        await pool.end();
      }
    }
  },
);

test("mail admission rejects invalid configuration", () => {
  const tx = async <T>(): Promise<T> => {
    throw new Error("unexpected transaction");
  };
  const limits = {
    windowSeconds: 60,
    accountAttempts: 2,
    sourceAttempts: 3,
    globalAttempts: 0,
  };
  assert.throws(() =>
    createAuthMailAdmission({
      transaction: tx,
      namespaceSecret: randomBytes(32),
      limits,
    }),
  );
});
