import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  verifyTenantActor,
  type BearerSessionVerifier,
} from "../src/session-context.js";

test("opaque session authority validation and propagation", async () => {
  const tenantId = randomUUID();
  const identityId = randomUUID();
  const claims = {
    tenantId,
    identityId,
    expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
  };
  const authority = {
    tokenSha256: "a".repeat(64),
    issuer: "cookie-f1-test",
    audience: "booking-test",
  };

  const verify = async (value: unknown) =>
    verifyTenantActor("Bearer test_token", tenantId, {
      verifyBearerToken: async () => ({
        ...claims,
        opaqueSessionAuthority: value,
      }),
    } as unknown as BearerSessionVerifier);

  const valid = await verify(authority);
  assert.ok(valid.actor);
  assert.equal(valid.actor.tenantId, tenantId);
  assert.equal(valid.actor.identityId, identityId);
  assert.deepEqual(valid.actor.opaqueSessionAuthority, authority);

  for (const malformed of [
    null,
    { ...authority, tokenSha256: "too-short" },
    { ...authority, issuer: "" },
    { ...authority, audience: 123 },
  ]) {
    const invalid = await verify(malformed);
    assert.equal(invalid.actor, undefined);
    assert.equal(invalid.status, 401);
  }

  const foreign = await verifyTenantActor("Bearer test_token", randomUUID(), {
    verifyBearerToken: async () => ({
      ...claims,
      opaqueSessionAuthority: authority,
    }),
  });
  assert.equal(foreign.status, 403);

  const legacy = await verifyTenantActor("Bearer test_token", tenantId, {
    verifyBearerToken: async () => claims,
  });
  assert.ok(legacy.actor);
  assert.equal(legacy.actor.opaqueSessionAuthority, undefined);
});
