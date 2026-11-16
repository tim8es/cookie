import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  verifyTenantActor,
  type BearerSessionVerifier,
} from "../src/session-context.js";

test("opaque Cookie issuer/audience provenance must match verified bearer", async () => {
  const token = "cs_" + "a".repeat(43);
  const tenantId = randomUUID();
  const identityId = randomUUID();
  const digest = createHash("sha256").update(token).digest("hex");
  const claims = {
    tenantId,
    identityId,
    expiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 600,
  };
  const authority = {
    tokenSha256: digest,
    issuer: "cookie-f1-test",
    audience: "booking-f1-test",
  };
  const verify = async (provenance: unknown) =>
    verifyTenantActor("Bearer " + token, tenantId, {
      verifyBearerToken: async () => ({
        ...claims,
        opaqueSessionAuthority: provenance,
      }),
    } as unknown as BearerSessionVerifier);

  const valid = await verify(authority);
  assert.ok(valid.actor);
  assert.equal(valid.actor.opaqueSessionTokenSha256, digest);
  assert.equal(valid.actor.opaqueSessionIssuer, authority.issuer);
  assert.equal(valid.actor.opaqueSessionAudience, authority.audience);

  for (const invalidAuthority of [
    null,
    { ...authority, tokenSha256: "0".repeat(64) },
    { ...authority, issuer: "" },
    { ...authority, audience: 123 },
  ]) {
    const denied = await verify(invalidAuthority);
    assert.equal(denied.status, 401);
    assert.equal(denied.actor, undefined);
  }

  const wrongTenant = await verifyTenantActor("Bearer " + token, randomUUID(), {
    verifyBearerToken: async () => ({
      ...claims,
      opaqueSessionAuthority: authority,
    }),
  });
  assert.equal(wrongTenant.status, 403);

  const synthetic = await verifyTenantActor("Bearer " + token, tenantId, {
    verifyBearerToken: async () => claims,
  });
  assert.ok(synthetic.actor);
  assert.equal(synthetic.actor.opaqueSessionIssuer, undefined);
  assert.equal(synthetic.actor.opaqueSessionAudience, undefined);
});
