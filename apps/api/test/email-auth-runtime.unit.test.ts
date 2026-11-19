import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import {
  createLiveEmailIdentityAuth,
  startAuthMailWorker,
} from "../src/email-auth-runtime.js";

test("email runtime is disabled by default and rejects invalid modes", () => {
  assert.equal(createLiveEmailIdentityAuth({}, {} as Pool), null);
  assert.throws(
    () =>
      createLiveEmailIdentityAuth(
        { COOKIE_EMAIL_AUTH_MODE: "true" },
        {} as Pool,
      ),
    /Invalid COOKIE_EMAIL_AUTH_MODE/,
  );
  assert.throws(
    () =>
      createLiveEmailIdentityAuth(
        { COOKIE_EMAIL_AUTH_MODE: "enabled" },
        {} as Pool,
      ),
    /COOKIE_AUTH_EMAIL_FINGERPRINT_SECRET/,
  );
  assert.throws(
    () =>
      createLiveEmailIdentityAuth(
        {
          COOKIE_EMAIL_AUTH_MODE: "enabled",
          COOKIE_AUTH_EMAIL_FINGERPRINT_SECRET: "1".repeat(64),
          COOKIE_AUTH_MAIL_ADMISSION_SECRET: "2".repeat(64),
          COOKIE_AUTH_MAIL_ENCRYPTION_KEY: "3".repeat(64),
        },
        {} as Pool,
      ),
    /COOKIE_AUTH_SECURITY_AUDIT_RETENTION_SECONDS/,
  );
});

test("enabled email runtime validates config and composes identity sessions and mail work", () => {
  const env = {
    COOKIE_EMAIL_AUTH_MODE: "enabled",
    COOKIE_AUTH_EMAIL_FINGERPRINT_SECRET: "1".repeat(64),
    COOKIE_AUTH_MAIL_ADMISSION_SECRET: "2".repeat(64),
    COOKIE_AUTH_MAIL_ENCRYPTION_KEY: "3".repeat(64),
    COOKIE_AUTH_SECURITY_AUDIT_RETENTION_SECONDS: "86400",
    COOKIE_AUTH_MAIL_SENDMAIL_PATH:
      process.platform === "win32" ? "C:\\sendmail.exe" : "/usr/sbin/sendmail",
    COOKIE_AUTH_MAIL_FROM: "noreply@example.invalid",
    COOKIE_PUBLIC_ORIGIN: "https://cookie.example.invalid",
  };
  const runtime = createLiveEmailIdentityAuth(env, {} as Pool);
  assert.ok(runtime);
  assert.equal(typeof runtime.routes.login, "function");
  assert.equal(typeof runtime.routes.enqueueEmailLink, "function");
  assert.equal(typeof runtime.routes.completeEmailLink, "function");
  assert.equal(typeof runtime.worker.runOnce, "function");
  assert.equal(typeof runtime.worker.maintain, "function");

  const altareRuntime = createLiveEmailIdentityAuth(
    {
      ...env,
      COOKIE_AUTH_MAIL_TRANSPORT: "altare-api",
      COOKIE_AUTH_MAIL_SENDMAIL_PATH: "",
      ALTARE_EMAIL_TOKEN: "aem_test-secret-token",
    },
    {} as Pool,
  );
  assert.ok(altareRuntime);
  assert.throws(
    () =>
      createLiveEmailIdentityAuth(
        {
          ...env,
          COOKIE_AUTH_MAIL_TRANSPORT: "altare-api",
          ALTARE_EMAIL_TOKEN: "",
        },
        {} as Pool,
      ),
    /Invalid Altare email configuration/,
  );
});

test("mail worker runs serially and waits for active work during shutdown", async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let signalFirst!: () => void;
  let signalSecond!: () => void;
  const firstStarted = new Promise<void>((resolve) => (signalFirst = resolve));
  const secondStarted = new Promise<void>(
    (resolve) => (signalSecond = resolve),
  );
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
  let runs = 0;
  let active = 0;
  let maxActive = 0;
  let maintenance = 0;
  const stop = startAuthMailWorker(
    {
      maintain: async () => {
        maintenance += 1;
      },
      runOnce: async () => {
        runs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (runs === 1) signalFirst();
        if (runs === 2) signalSecond();
        await (runs === 1 ? firstGate : secondGate);
        active -= 1;
      },
    },
    () => assert.fail("worker failure"),
    250,
  );

  await firstStarted;
  releaseFirst();
  await secondStarted;
  const stopping = stop();
  releaseSecond();
  await stopping;

  assert.equal(maintenance, 1);
  assert.equal(runs, 2);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
});

test("registration proof completion reserves shared source and proof budgets", async () => {
  const attempts = new Map<string, number>();
  const client = {
    async query(query: unknown, values?: unknown[]) {
      const sql = typeof query === "string" ? query : String(query);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
        return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT (floor(extract(epoch"))
        return { rows: [{ window_start: "1700000000" }], rowCount: 1 };
      if (sql.includes("INSERT INTO cookie_identity.email_login_attempts")) {
        const key = `${values?.[0]}:${(values?.[1] as Buffer).toString("hex")}`;
        const count = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, count);
        return { rows: [{ attempts: count }], rowCount: 1 };
      }
      if (sql.includes("SELECT $1::bigint <= floor"))
        return { rows: [{ active: true }], rowCount: 1 };
      if (sql.includes("email_registration_challenges"))
        return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected synthetic database query: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const runtime = createLiveEmailIdentityAuth(
    {
      COOKIE_EMAIL_AUTH_MODE: "enabled",
      COOKIE_AUTH_EMAIL_FINGERPRINT_SECRET: "1".repeat(64),
      COOKIE_AUTH_MAIL_ADMISSION_SECRET: "2".repeat(64),
      COOKIE_AUTH_MAIL_ENCRYPTION_KEY: "3".repeat(64),
      COOKIE_AUTH_SECURITY_AUDIT_RETENTION_SECONDS: "86400",
      COOKIE_AUTH_LOGIN_ACCOUNT_ATTEMPTS: "5",
      COOKIE_AUTH_LOGIN_SOURCE_ATTEMPTS: "30",
      COOKIE_AUTH_MAIL_SENDMAIL_PATH:
        process.platform === "win32"
          ? "C:\\sendmail.exe"
          : "/usr/sbin/sendmail",
      COOKIE_AUTH_MAIL_FROM: "noreply@example.invalid",
      COOKIE_PUBLIC_ORIGIN: "https://cookie.example.invalid",
    },
    pool,
  );
  assert.ok(runtime);
  const source = Buffer.alloc(32, 7);
  const proof = "er_" + "A".repeat(43);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal(
      await runtime.routes.completeRegistration(
        proof,
        "synthetic password long enough",
        source,
      ),
      null,
    );
  }
  assert.deepEqual(
    [...attempts.values()].sort((a, b) => a - b),
    [6, 6],
  );
});

test("email auth maintenance purges expiring proofs, attempt windows and retained audit rows", async () => {
  const queries: string[] = [];
  const client = {
    async query(query: unknown) {
      queries.push(typeof query === "string" ? query : String(query));
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const runtime = createLiveEmailIdentityAuth(
    {
      COOKIE_EMAIL_AUTH_MODE: "enabled",
      COOKIE_AUTH_EMAIL_FINGERPRINT_SECRET: "1".repeat(64),
      COOKIE_AUTH_MAIL_ADMISSION_SECRET: "2".repeat(64),
      COOKIE_AUTH_MAIL_ENCRYPTION_KEY: "3".repeat(64),
      COOKIE_AUTH_SECURITY_AUDIT_RETENTION_SECONDS: "86400",
      COOKIE_AUTH_MAIL_SENDMAIL_PATH:
        process.platform === "win32"
          ? "C:\\sendmail.exe"
          : "/usr/sbin/sendmail",
      COOKIE_AUTH_MAIL_FROM: "noreply@example.invalid",
      COOKIE_PUBLIC_ORIGIN: "https://cookie.example.invalid",
    },
    { connect: async () => client } as unknown as Pool,
  );
  assert.ok(runtime);
  await runtime.worker.maintain();
  for (const table of [
    "auth_mail_jobs",
    "email_registration_challenges",
    "email_password_recovery_challenges",
    "email_login_attempts",
    "auth_security_events",
  ]) {
    assert.ok(
      queries.some((sql) => sql.includes(table)),
      table,
    );
  }
});
