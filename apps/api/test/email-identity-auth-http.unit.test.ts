import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";
import type { EmailIdentityAuthDependencies } from "../src/email-identity-auth-http.js";

function dependencies(
  overrides: Partial<EmailIdentityAuthDependencies> = {},
): EmailIdentityAuthDependencies {
  return {
    sourceFingerprintSecret: Buffer.alloc(32, 1),
    enqueueMail: async () => undefined,
    completeRegistration: async () => "00000000-0000-4000-8000-000000000001",
    login: async () => ({ status: "denied" }),
    completePasswordRecovery: async () => true,
    ...overrides,
  };
}

test("email auth advertises only enabled methods and keeps request routes private", async (t) => {
  const app = createApp(
    { query: async () => ({ rows: [] }) },
    {
      emailIdentityRoutes: dependencies(),
    },
  );
  t.after(() => app.close());

  const methods = await app.inject({ method: "GET", url: "/v1/auth/methods" });
  assert.deepEqual(methods.json(), {
    methods: ["email"],
    telegram: { miniApp: false, webOidc: false },
    stagingCustomerEnrollment: false,
  });
  assert.equal(methods.headers["cache-control"], "no-store");

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/auth/email/registration/request",
    payload: { email: "a@example.invalid", extra: true },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.headers["cache-control"], "no-store");
});

test("mail requests are generic and pass only a source fingerprint to admission", async (t) => {
  const calls: Array<{ purpose: string; email: unknown; source: Buffer }> = [];
  const app = createApp(
    { query: async () => ({ rows: [] }) },
    {
      emailIdentityRoutes: dependencies({
        enqueueMail: async (purpose, email, source) => {
          calls.push({ purpose, email, source });
        },
      }),
    },
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/email/password-recovery/request",
    payload: { email: "person@example.invalid" },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true });
  assert.equal(
    JSON.stringify(response.json()).includes("person@example.invalid"),
    false,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.purpose, "password-recovery");
  assert.equal(calls[0]?.email, "person@example.invalid");
  assert.equal(calls[0]?.source.length, 32);
});

test("registration uses a 15-code-point password and never returns Identity IDs", async (t) => {
  let calls = 0;
  const app = createApp(
    { query: async () => ({ rows: [] }) },
    {
      emailIdentityRoutes: dependencies({
        completeRegistration: async () => {
          calls += 1;
          return "00000000-0000-4000-8000-000000000001";
        },
      }),
    },
  );
  t.after(() => app.close());

  const short = await app.inject({
    method: "POST",
    url: "/v1/auth/email/registration/complete",
    payload: { token: "er_" + "a".repeat(43), password: "short" },
  });
  assert.equal(short.statusCode, 400);
  assert.equal(calls, 0);

  const accepted = await app.inject({
    method: "POST",
    url: "/v1/auth/email/registration/complete",
    payload: { token: "er_" + "a".repeat(43), password: "ёжик-ёжик-ёжик!" },
  });
  assert.equal(accepted.statusCode, 201);
  assert.deepEqual(accepted.json(), { registered: true });
  assert.equal(JSON.stringify(accepted.json()).includes("00000000"), false);
  assert.equal(calls, 1);
});

test("denied and throttled email logins have the same public response", async (t) => {
  let attempt = 0;
  const app = createApp(
    { query: async () => ({ rows: [] }) },
    {
      emailIdentityRoutes: dependencies({
        login: async () =>
          ++attempt === 1 ? { status: "denied" } : { status: "throttled" },
      }),
    },
  );
  t.after(() => app.close());

  const request = () =>
    app.inject({
      method: "POST",
      url: "/v1/auth/email/login",
      payload: { email: "person@example.invalid", password: "incorrect" },
    });
  const denied = await request();
  const throttled = await request();
  assert.equal(denied.statusCode, 401);
  assert.equal(throttled.statusCode, 401);
  assert.deepEqual(denied.json(), throttled.json());
});
