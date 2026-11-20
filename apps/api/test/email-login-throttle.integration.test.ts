import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import {
  purgeExpiredEmailLoginAttempts,
  reserveEmailLoginAttempt,
} from "../../../packages/platform-identity/src/email-login-throttle.js";

test(
  "login throttle shares account and source budgets across concurrent transactions",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 8,
    });
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const limits = {
      windowSeconds: 3600,
      accountAttempts: 2,
      sourceAttempts: 1,
    };
    const account = randomBytes(32);
    const freshAccount = randomBytes(32);
    const sources = Array.from({ length: 6 }, () => randomBytes(32));
    const all = [account, freshAccount, ...sources];

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const admitted = await Promise.all(
        sources.map((source) =>
          reserveEmailLoginAttempt(transaction, limits, source, account),
        ),
      );
      assert.equal(admitted.filter(Boolean).length, 2);

      // Sources spent their budget, including the account-denied attempts.
      // They cannot exhaust a different account's budget.
      for (const source of sources) {
        assert.equal(
          await reserveEmailLoginAttempt(
            transaction,
            limits,
            source,
            freshAccount,
          ),
          false,
        );
      }
      const untouched = await pool.query(
        "SELECT 1 FROM cookie_identity.email_login_attempts WHERE scope='account' AND subject_hmac_sha256=$1",
        [freshAccount],
      );
      assert.equal(untouched.rowCount, 0);

      const newSource = randomBytes(32);
      all.push(newSource);
      assert.equal(
        await reserveEmailLoginAttempt(transaction, limits, newSource, null),
        true,
      );
      assert.equal(
        await reserveEmailLoginAttempt(
          transaction,
          limits,
          newSource,
          freshAccount,
        ),
        false,
      );

      const expired = randomBytes(32);
      all.push(expired);
      await pool.query(
        "INSERT INTO cookie_identity.email_login_attempts(scope,subject_hmac_sha256,window_start_epoch,window_seconds,attempts) VALUES ('source',$1,0,3600,1)",
        [expired],
      );
      assert.equal(await purgeExpiredEmailLoginAttempts(transaction, 1), 1);
      const remaining = await pool.query(
        "SELECT 1 FROM cookie_identity.email_login_attempts WHERE subject_hmac_sha256=$1",
        [expired],
      );
      assert.equal(remaining.rowCount, 0);
      const active = await pool.query(
        "SELECT 1 FROM cookie_identity.email_login_attempts WHERE subject_hmac_sha256=$1",
        [account],
      );
      assert.equal(active.rowCount, 1);
    } finally {
      try {
        for (const fingerprint of all) {
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

test("invalid throttle inputs fail before opening a transaction", async () => {
  const transaction = async <T>(): Promise<T> => {
    throw new Error("unexpected transaction");
  };
  const limits = {
    windowSeconds: 60,
    accountAttempts: 2,
    sourceAttempts: 3,
  };
  await assert.rejects(
    reserveEmailLoginAttempt(transaction, limits, Buffer.alloc(31), null),
    /Invalid login throttle/,
  );
  await assert.rejects(
    reserveEmailLoginAttempt(
      transaction,
      { ...limits, accountAttempts: 0 },
      Buffer.alloc(32),
      null,
    ),
    /Invalid login throttle/,
  );
  await assert.rejects(
    purgeExpiredEmailLoginAttempts(transaction, 0),
    /Invalid login throttle/,
  );
});
