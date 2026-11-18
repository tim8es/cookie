import assert from "node:assert/strict";
import test from "node:test";

import {
  completeEmailCredentialLink,
  createOwnerWorkspace,
  discoverAuthMethods,
  enrollCustomer,
  IdentityAuthFailure,
  loginEmailPassword,
  loginTelegramMiniApp,
  selectTelegramTransport,
  verifyStagingCustomerSession,
  type IdentityAuthSession,
} from "./identity-auth.js";

const session: IdentityAuthSession = {
  accessToken: "is_" + "A".repeat(43),
  expiresAtUnixSeconds: 1800,
};
const tenantId = "11111111-1111-4111-8111-111111111111";

test("auth method discovery is private and reports independently enabled providers", async () => {
  let request: Request | undefined;
  const result = await discoverAuthMethods(async (_input, init) => {
    request = new Request(
      "https://cookie.example.invalid/v1/auth/methods",
      init,
    );
    return Response.json({
      methods: ["email", "telegram"],
      telegram: { miniApp: true, webOidc: false },
      stagingCustomerEnrollment: true,
    });
  });
  assert.deepEqual(result, {
    email: true,
    telegramMiniApp: true,
    telegramWebOidc: false,
    stagingCustomerEnrollment: true,
  });
  assert.equal(request?.cache, "no-store");
  assert.equal(request?.credentials, "omit");
});

test("Telegram uses one transport for the current environment", () => {
  const both = {
    email: false,
    telegramMiniApp: true,
    telegramWebOidc: true,
    stagingCustomerEnrollment: false,
  };
  assert.equal(selectTelegramTransport(both, true), "mini-app");
  assert.equal(selectTelegramTransport(both, false), "web");
  assert.equal(
    selectTelegramTransport({ ...both, telegramWebOidc: false }, false),
    null,
  );
  assert.equal(
    selectTelegramTransport({ ...both, telegramMiniApp: false }, true),
    "web",
  );
  assert.equal(selectTelegramTransport(null, true), null);
});

test("email login rejects a malformed session instead of retaining a token", async () => {
  await assert.rejects(
    loginEmailPassword(
      "person@example.invalid",
      "password",
      async () =>
        Response.json({
          tokenType: "Bearer",
          scope: "identity",
          accessToken: "not-a-session",
          expiresAtUnixSeconds: 1800,
        }),
      1000,
    ),
    (error: unknown) =>
      error instanceof IdentityAuthFailure &&
      error.reason === "invalid-response",
  );
});

test("Telegram-only registration uses the independent register intent", async () => {
  let sent: Request | undefined;
  const result = await loginTelegramMiniApp(
    "verified-mini-app-proof",
    "register",
    async (_input, init) => {
      sent = new Request(
        "https://cookie.example.invalid/v1/auth/telegram/identity",
        init,
      );
      return Response.json(
        {
          tokenType: "Bearer",
          scope: "identity",
          accessToken: session.accessToken,
          expiresAtUnixSeconds: 1800,
        },
        { status: 201 },
      );
    },
    1000,
  );
  assert.deepEqual(await sent?.json(), {
    initData: "verified-mini-app-proof",
    intent: "register",
  });
  assert.deepEqual(result, session);
});

test("owner workspace request keeps the idempotency key out of the strict form body", async () => {
  const input = {
    key: "owner-setup-00000001",
    organizationName: "Тестик",
    locationName: "Тестик первый",
    timeZone: "Europe/Moscow",
  };
  const locationId = "22222222-2222-4222-8222-222222222222";
  let sent: Request | undefined;
  const result = await createOwnerWorkspace(
    session,
    input,
    input.key,
    async (_url, init) => {
      sent = new Request(
        "https://cookie.example.invalid/v1/auth/owner/workspace",
        init,
      );
      return Response.json(
        { tenantId, locationId, replayed: false },
        { status: 201 },
      );
    },
  );

  assert.equal(sent?.headers.get("idempotency-key"), input.key);
  assert.deepEqual(await sent?.json(), {
    organizationName: input.organizationName,
    locationName: input.locationName,
    timeZone: input.timeZone,
  });
  assert.deepEqual(result, { tenantId, locationId });
});

test("email linking uses the current identity bearer and one-time proof body", async () => {
  let sent: Request | undefined;
  await completeEmailCredentialLink(
    session,
    "el_" + "B".repeat(43),
    "long staging password",
    async (_input, init) => {
      sent = new Request(
        "https://cookie.example.invalid/v1/auth/email/link/complete",
        init,
      );
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(
    sent?.headers.get("authorization"),
    "Bearer " + session.accessToken,
  );
  assert.deepEqual(await sent?.json(), {
    token: "el_" + "B".repeat(43),
    password: "long staging password",
  });
  assert.equal(new URL(sent!.url).search, "");
});

test("staging customer enrollment sends consent and accepts only its tenant receipt", async () => {
  let sent: Request | undefined;
  const enrolled = await enrollCustomer(
    session,
    tenantId,
    async (_input, init) => {
      sent = new Request(
        `https://cookie.example.invalid/v1/organizations/${tenantId}/staging-customer/enroll`,
        init,
      );
      return Response.json({
        tenantId,
        customerId: "22222222-2222-4222-8222-222222222222",
      });
    },
  );
  assert.equal(
    sent?.headers.get("authorization"),
    "Bearer " + session.accessToken,
  );
  assert.deepEqual(await sent?.json(), { consentConfirmed: true });
  assert.equal(enrolled.tenantId, tenantId);
  assert.equal(enrolled.customerId, "22222222-2222-4222-8222-222222222222");
});

test("a non-customer Telegram tenant session is revoked when client context fails", async () => {
  const requests: string[] = [];
  const tenantSession = {
    accessToken: "cs_" + "C".repeat(43),
    tenantId,
    expiresAtUnixSeconds: 1800,
  };
  await assert.rejects(
    verifyStagingCustomerSession(tenantSession, async (input, init) => {
      requests.push(String(input));
      return init?.method === "POST"
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 403 });
    }),
    (error: unknown) =>
      error instanceof IdentityAuthFailure && error.reason === "unauthorized",
  );
  assert.deepEqual(requests, [
    `/v1/organizations/${tenantId}/staging-customer-context`,
    "/v1/auth/logout",
  ]);
});
