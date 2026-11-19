import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { createApp } from "../src/app.js";
import { verifyTenantActor } from "../src/session-context.js";
import type {
  ProtectedSessionDependencies,
  VerifiedSession,
  BearerSessionVerifier,
} from "../src/session-context.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const route = "/v1/organizations/" + TENANT_A + "/session-context";
const readDatabase = { query: async () => ({ rows: [] }) };

function validSession(
  overrides: Partial<VerifiedSession> = {},
): VerifiedSession {
  return {
    identityId: IDENTITY,
    tenantId: TENANT_A,
    expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<ProtectedSessionDependencies> = {},
): ProtectedSessionDependencies {
  return {
    verifier: { verifyBearerToken: async () => validSession() },
    policy: { assertPermission: async () => undefined },
    ...overrides,
  };
}

test("session-context is absent in the ordinary API without a verified auth provider", async (t) => {
  const app = createApp(readDatabase);
  t.after(async () => app.close());
  const response = await app.inject({ method: "GET", url: route });
  assert.equal(response.statusCode, 404);
});

test("missing token and spoofed actor headers cannot authenticate", async (t) => {
  let verifierCalls = 0;
  const app = createApp(readDatabase, {
    sessionRoutes: dependencies({
      verifier: {
        verifyBearerToken: async () => {
          verifierCalls++;
          return validSession();
        },
      },
    }),
  });
  t.after(async () => app.close());
  const r = await app.inject({
    method: "GET",
    url: route,
    headers: { "x-tenant-id": TENANT_A, "x-identity-id": IDENTITY },
  });
  assert.equal(r.statusCode, 401);
  assert.equal(verifierCalls, 0);
  const malformed = await app.inject({
    method: "GET",
    url: route,
    headers: { authorization: "Bearer token1, Bearer token2" },
  });
  assert.equal(malformed.statusCode, 401);
  assert.equal(verifierCalls, 0);
});

test("invalid, expired and failed verifier sessions fail closed without leaking errors", async (t) => {
  const app = createApp(readDatabase, {
    sessionRoutes: dependencies({
      verifier: {
        verifyBearerToken: async (token) => {
          if (token === "broken") throw new Error("sensitive signing key");
          if (token === "expired")
            return validSession({ expiresAtUnixSeconds: 1 });
          if (token === "invalid-claim")
            return validSession({ tenantId: "bogus" });
          return null;
        },
      },
    }),
  });
  t.after(async () => app.close());
  for (const token of ["broken", "expired", "invalid-claim", "unknown"]) {
    const r = await app.inject({
      method: "GET",
      url: route,
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(r.statusCode, 401, token);
    assert.equal(r.json().error, "unauthorized");
    assert.doesNotMatch(r.body, /sensitive signing key/);
  }
});

test("tenant is selected from the verified session, not a request URL or arbitrary headers", async (t) => {
  let policyCalls = 0;
  const app = createApp(readDatabase, {
    sessionRoutes: dependencies({
      policy: {
        assertPermission: async () => {
          policyCalls++;
        },
      },
    }),
  });
  t.after(async () => app.close());
  const r = await app.inject({
    method: "GET",
    url: "/v1/organizations/" + TENANT_B + "/session-context",
    headers: {
      authorization: "Bearer valid.test.token",
      "x-tenant-id": TENANT_B,
    },
  });
  assert.equal(r.statusCode, 403);
  assert.equal(policyCalls, 0);
});

test("successful request uses generated correlation and permission-checked identity", async (t) => {
  const seen: Array<{
    actor: { identityId: string; tenantId: string; correlationId: string };
    resource: { kind: string; tenantId: string };
    permission: string;
  }> = [];
  const app = createApp(readDatabase, {
    sessionRoutes: dependencies({
      policy: {
        assertPermission: async (actor, resource, permission) => {
          seen.push({ actor, resource, permission });
        },
      },
    }),
  });
  t.after(async () => app.close());

  const response = await app.inject({
    method: "GET",
    url: route,
    headers: {
      authorization: "Bearer valid.test.token",
      "x-tenant-id": TENANT_B,
      "x-identity-id": TENANT_B,
      "x-correlation-id": "spoofed",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Authorization");
  assert.deepEqual(response.json(), { tenantId: TENANT_A });
  assert.equal(seen[0]?.actor.identityId, IDENTITY);
  assert.equal(seen[0]?.actor.tenantId, TENANT_A);
  assert.equal(seen[0]?.resource.kind, "organization");
  assert.equal(seen[0]?.resource.tenantId, TENANT_A);
  assert.equal(seen[0]?.permission, "organization.context.read");
  assert.match(seen[0]?.actor.correlationId ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(seen[0]?.actor.correlationId, "spoofed");
});

test("policy denial is 403, storage failure is 503 with no sensitive details", async (t) => {
  const denied = createApp(readDatabase, {
    sessionRoutes: dependencies({
      policy: {
        assertPermission: async () => {
          throw new AuthorizationDeniedError();
        },
      },
    }),
  });
  const failed = createApp(readDatabase, {
    sessionRoutes: dependencies({
      policy: {
        assertPermission: async () => {
          throw new Error("password=secret");
        },
      },
    }),
  });
  t.after(async () => {
    await denied.close();
    await failed.close();
  });

  const options = {
    method: "GET" as const,
    url: route,
    headers: { authorization: "Bearer valid.test.token" },
  };
  const forbidden = await denied.inject(options);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.headers["cache-control"], "no-store");
  assert.deepEqual(forbidden.json(), { error: "forbidden" });
  const unavailable = await failed.inject(options);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers["cache-control"], "no-store");
  assert.deepEqual(unavailable.json(), { error: "unavailable" });
  assert.doesNotMatch(unavailable.body, /password=secret/);
});

test("Cookie-format verifier must bind server-owned digest and issuer/audience", async () => {
  const token = "cs_" + "A".repeat(43);
  const session = validSession();
  const hash = createHash("sha256").update(token).digest("hex");
  const authority = {
    tokenSha256: hash,
    issuer: "cookie-qa",
    audience: "booking-qa",
  };
  const authenticate = async (provided: unknown) =>
    verifyTenantActor("Bearer " + token, TENANT_A, {
      verifyBearerToken: async () => ({
        ...session,
        opaqueSessionAuthority: provided,
      }),
    } as BearerSessionVerifier);
  const accepted = await authenticate(authority);
  assert.deepEqual(accepted.actor?.opaqueSessionAuthority, authority);
  for (const malformed of [
    undefined,
    null,
    { ...authority, tokenSha256: "f".repeat(64) },
    { ...authority, issuer: "" },
    { ...authority, audience: 12 },
  ]) {
    const rejected = await authenticate(malformed);
    assert.equal(rejected.actor, undefined);
    assert.equal(rejected.status, 401);
  }
});

test("global Identity bearer keeps its authority type while tenant membership stays protected", async () => {
  const token = "is_" + "B".repeat(43);
  const digest = createHash("sha256").update(token).digest("hex");
  let requestedTenant = "";
  const verified = await verifyTenantActor("Bearer " + token, TENANT_A, {
    verifyBearerToken: async (value, tenantId) => {
      assert.equal(value, token);
      requestedTenant = tenantId ?? "";
      return {
        ...validSession(),
        tenantId: tenantId ?? "",
        opaqueSessionAuthority: {
          tokenSha256: digest,
          issuer: "cookie-email",
          audience: "cookie-web",
          kind: "identity",
        },
      };
    },
  });
  assert.equal(requestedTenant, TENANT_A);
  assert.equal(verified.actor?.tenantId, TENANT_A);
  assert.equal(verified.actor?.opaqueSessionAuthority?.kind, "identity");

  const forgedType = await verifyTenantActor("Bearer " + token, TENANT_A, {
    verifyBearerToken: async () => ({
      ...validSession(),
      opaqueSessionAuthority: {
        tokenSha256: digest,
        issuer: "cookie-email",
        audience: "cookie-web",
      },
    }),
  });
  assert.equal(forgedType.status, 401);
});
