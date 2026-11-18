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
});

test("enabled email runtime validates config and composes identity sessions and mail work", () => {
  const env = {
    COOKIE_EMAIL_AUTH_MODE: "enabled",
    COOKIE_AUTH_EMAIL_FINGERPRINT_SECRET: "1".repeat(64),
    COOKIE_AUTH_MAIL_ADMISSION_SECRET: "2".repeat(64),
    COOKIE_AUTH_MAIL_ENCRYPTION_KEY: "3".repeat(64),
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
