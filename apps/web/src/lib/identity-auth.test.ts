import assert from "node:assert/strict";
import test from "node:test";

import {
  checkBrowserIdentitySession,
  completeEmailCredentialLink,
  createOwnerWorkspace,
  discoverAuthMethods,
  enrollCustomer,
  IdentityAuthFailure,
  loginEmailPassword,
  loginTelegramMiniApp,
  selectTelegramTransport,
  restoreBrowserIdentitySession,
  restoreWorkspaceContext,
  type IdentityOrganization,
  verifyStagingCustomerSession,
  type IdentityAuthSession,
} from "./identity-auth.js";
import { parseWorkspaceHint } from "./workspace-hint.js";

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

test("restore uses same-origin cookie without replay or browser storage", async () => {
  let sent: Request | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    sent = new Request(
      "https://cookie.example.invalid/v1/auth/browser-session",
      init,
    );
    return Response.json({
      tokenType: "Bearer",
      scope: "identity",
      ...session,
    });
  };
  const result = await restoreBrowserIdentitySession(fetcher, 1000);
  assert.deepEqual(result, session);
  assert.equal(sent?.method, "GET");
  assert.equal(sent?.credentials, "same-origin");
  assert.equal(sent?.cache, "no-store");
  assert.equal(sent?.headers.get("authorization"), null);
  assert.equal(sent?.headers.get("x-kuki-session"), "1");
  const denied = async () => new Response(null, { status: 401 });
  const unavailable = async () => new Response(null, { status: 503 });
  assert.equal(await restoreBrowserIdentitySession(denied), null);
  await assert.rejects(restoreBrowserIdentitySession(unavailable));
});

test("denied customer context preserves the global identity", async () => {
  const requests: string[] = [];
  await assert.rejects(
    verifyStagingCustomerSession({ ...session, tenantId }, async (input) => {
      requests.push(String(input));
      return new Response(null, { status: 403 });
    }),
    (error: unknown) =>
      error instanceof IdentityAuthFailure && error.reason === "unauthorized",
  );
  assert.deepEqual(requests, [
    `/v1/organizations/${tenantId}/staging-customer-context`,
  ]);
});

test("cross-tab session checks distinguish change from outage", async () => {
  const now = 1000;
  const matching = async () =>
    Response.json({ tokenType: "Bearer", scope: "identity", ...session });
  const different = async () =>
    Response.json({
      tokenType: "Bearer",
      scope: "identity",
      ...session,
      accessToken: "is_" + "B".repeat(43),
    });
  const missing = async () => new Response(null, { status: 401 });
  const offline = async () => new Response(null, { status: 503 });
  assert.equal(
    await checkBrowserIdentitySession(session, matching, now),
    "match",
  );
  assert.equal(
    await checkBrowserIdentitySession(session, different, now),
    "changed",
  );
  assert.equal(
    await checkBrowserIdentitySession(session, missing, now),
    "changed",
  );
  assert.equal(
    await checkBrowserIdentitySession(session, offline, now),
    "unavailable",
  );
});

test("workspace resume accepts only a noncredential role and tenant hint", () => {
  const hint = { role: "business", tenantId };
  assert.deepEqual(parseWorkspaceHint(hint), hint);
  assert.equal(parseWorkspaceHint({ ...hint, token: "secret" }), null);
  assert.equal(parseWorkspaceHint({ ...hint, role: "admin" }), null);
  assert.equal(parseWorkspaceHint({ ...hint, tenantId: "not-a-uuid" }), null);
});

test("workspace resume checks current role and context without enrolling", async () => {
  const org: IdentityOrganization = {
    tenantId,
    organizationName: "Synthetic organization",
    roleTypes: ["owner", "client"],
  };
  const requests: string[] = [];
  const customerId = "22222222-2222-4222-8222-222222222222";
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    requests.push(path);
    assert.equal(init?.method, "GET");
    return Response.json(
      path.endsWith("/staging-customer-context")
        ? { tenantId, customerId }
        : { tenantId },
    );
  };
  assert.deepEqual(
    await restoreWorkspaceContext(
      session,
      { role: "business", tenantId },
      [org],
      fetcher,
    ),
    { role: "business", session: { ...session, tenantId } },
  );
  assert.deepEqual(
    await restoreWorkspaceContext(
      session,
      { role: "customer", tenantId },
      [org],
      fetcher,
    ),
    { role: "customer", session: { ...session, tenantId, customerId } },
  );
  await assert.rejects(
    restoreWorkspaceContext(
      session,
      { role: "business", tenantId },
      [{ ...org, roleTypes: ["client"] }],
      fetcher,
    ),
  );
  assert.deepEqual(requests, [
    `/v1/organizations/${tenantId}/session-context`,
    `/v1/organizations/${tenantId}/staging-customer-context`,
  ]);
  const denied = async () => new Response(null, { status: 403 });
  await assert.rejects(
    restoreWorkspaceContext(
      session,
      { role: "business", tenantId },
      [org],
      denied,
    ),
  );
});
