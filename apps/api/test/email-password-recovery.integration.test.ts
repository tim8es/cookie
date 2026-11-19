import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

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

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

function pauseTransactionAfter(
  pool: Pool,
  matches: (sql: string) => boolean,
): { transaction: Transaction; paused: Promise<void>; resume: () => void } {
  let signal!: () => void;
  let release!: () => void;
  let hasPaused = false;
  let hasResumed = false;
  let pauseTimer: NodeJS.Timeout | undefined;
  const paused = new Promise<void>((resolvePause, rejectPause) => {
    signal = resolvePause;
    pauseTimer = setTimeout(
      () => rejectPause(new Error("Expected credential transaction pause")),
      5_000,
    );
    pauseTimer.unref();
  });
  const gate = new Promise<void>((resolveGate) => (release = resolveGate));
  const transaction: Transaction = (work) =>
    runSqlTransaction(pool, async (client) => {
      const originalQuery = client.query.bind(client) as (
        sql: string,
        values?: unknown[],
      ) => Promise<unknown>;
      const wrapped = new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return async (sql: string, values?: unknown[]) => {
              const result = await originalQuery(sql, values);
              if (!hasPaused && matches(sql)) {
                hasPaused = true;
                signal();
                await gate;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
      return work(wrapped);
    });
  return {
    transaction,
    paused,
    resume: () => {
      if (hasResumed) return;
      hasResumed = true;
      if (pauseTimer) clearTimeout(pauseTimer);
      release();
    },
  };
}

async function waitForCredentialLockWaiter(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE application_name='cookie-email-recovery-login-race'
           AND state='active' AND wait_event_type='Lock'
           AND query ILIKE '%email_credentials%'
       ) AS waiting`,
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("Expected a concurrent email credential lock waiter");
}

test(
  "password recovery consumes one generation, revokes sessions and rolls back",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-email-recovery-login-race",
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
    const tenantId = randomUUID();
    let identityId: string | null = null;
    const concurrentOperations: Promise<unknown>[] = [];
    const releaseGates: (() => void)[] = [];
    const audit = async () => {
      const result = await pool.query<{ event_type: string }>(
        "SELECT event_type FROM cookie_identity.auth_security_events WHERE identity_id=$1::uuid ORDER BY id",
        [identityId],
      );
      return result.rows.map((row) => row.event_type);
    };

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
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1::uuid,$2::uuid,'Synthetic recovery tenant')`,
        [tenantId, identityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES($1::uuid,$2::uuid)`,
        [tenantId, identityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.opaque_sessions
           (token_sha256,telegram_exchange_sha256,tenant_id,identity_id,
            issuer,audience,expires_at)
         VALUES($1::bytea,$2::bytea,$3::uuid,$4::uuid,
                'legacy-test','booking-test',clock_timestamp()+interval '1 hour')`,
        [randomBytes(32), randomBytes(32), tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [otherId],
      );
      const previous = await sessions.issueForVerifiedIdentity(identityId);
      const unrelated = await sessions.issueForVerifiedIdentity(otherId);

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
      assert.equal(await sessions.resolve(previous.token), identityId);
      assert.deepEqual(await audit(), ["email_registered"]);

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
      assert.equal(await sessions.resolve(previous.token), null);
      assert.equal(await sessions.resolve(unrelated.token), otherId);
      assert.equal(
        (
          await pool.query(
            `SELECT 1 FROM cookie_identity.opaque_sessions
             WHERE identity_id=$1::uuid AND revoked_at IS NULL`,
            [identityId],
          )
        ).rowCount,
        0,
      );
      assert.deepEqual(await audit(), [
        "email_registered",
        "password_recovered",
      ]);
      assert.equal(
        await completeEmailPasswordRecovery(
          transaction,
          gate,
          first.token,
          original,
        ),
        false,
      );

      const loginFirstGate = pauseTransactionAfter(
        pool,
        (sql) => sql.includes("email_credentials") && sql.includes("FOR SHARE"),
      );
      releaseGates.push(loginFirstGate.resume);
      const loginFirst = withVerifiedEmailPassword(
        loginFirstGate.transaction,
        gate,
        secret,
        email,
        changed,
        async (client, id) =>
          (await sessions.issueForVerifiedIdentityInTransaction(client, id))
            .token,
      );
      concurrentOperations.push(loginFirst);
      await loginFirstGate.paused;
      const recoveryAfterLogin = completeEmailPasswordRecovery(
        transaction,
        gate,
        (await issue())!.token,
        "synthetic final password",
      );
      concurrentOperations.push(recoveryAfterLogin);
      await waitForCredentialLockWaiter(pool);
      loginFirstGate.resume();
      const loginToken = await loginFirst;
      assert.ok(loginToken);
      assert.equal(await recoveryAfterLogin, true);
      assert.equal(await sessions.resolve(loginToken), null);

      const recoveryFirstGate = pauseTransactionAfter(
        pool,
        (sql) => sql.includes("email_credentials") && sql.includes("FOR UPDATE"),
      );
      releaseGates.push(recoveryFirstGate.resume);
      const recoveryFirst = completeEmailPasswordRecovery(
        recoveryFirstGate.transaction,
        gate,
        (await issue())!.token,
        "synthetic newest password",
      );
      concurrentOperations.push(recoveryFirst);
      await recoveryFirstGate.paused;
      const loginAfterRecovery = withVerifiedEmailPassword(
        transaction,
        gate,
        secret,
        email,
        "synthetic final password",
        async (_client, id) => id,
      );
      concurrentOperations.push(loginAfterRecovery);
      await waitForCredentialLockWaiter(pool);
      recoveryFirstGate.resume();
      assert.equal(await recoveryFirst, true);
      assert.equal(await loginAfterRecovery, null);
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
      assert.equal(await verify("synthetic newest password"), identityId);
      const batch = 10000;
      const purge = purgeExpiredEmailRecoveryChallenges;
      const purged = await purge(transaction, batch);
      assert.ok(purged > 0);
      const remaining = await pool.query(
        "SELECT 1 FROM cookie_identity.email_password_recovery_challenges WHERE email_hmac_sha256=$1",
        [fingerprint],
      );
      assert.equal(remaining.rowCount, 0);
    } finally {
      for (const resume of releaseGates) resume();
      await Promise.all(
        concurrentOperations.map((operation) => operation.catch(() => undefined)),
      );
      try {
        await pool.query(
          "DELETE FROM cookie_identity.auth_security_events WHERE identity_id=$1::uuid",
          [identityId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identity_sessions WHERE identity_id IN ($1::uuid,$2::uuid)",
          [identityId, otherId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.memberships WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenantId],
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
