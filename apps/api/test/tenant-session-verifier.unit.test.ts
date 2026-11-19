import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  IdentitySessions,
  PostgresOpaqueTelegramSessions,
} from "../../../packages/platform-identity/src/index.js";
import { createTenantSessionVerifier } from "../src/tenant-session-verifier.js";

const IDENTITY = "00000000-0000-4000-8000-000000000001";
const TENANT = "00000000-0000-4000-8000-000000000002";

test("tenant verifier keeps legacy tokens on the legacy verifier", async () => {
  const token = "cs_" + "A".repeat(43);
  let received = "";
  const verifier = createTenantSessionVerifier(
    {
      verifyBearerToken: async (value: string) => {
        received = value;
        return {
          identityId: IDENTITY,
          tenantId: TENANT,
          expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 60,
        };
      },
    } as unknown as PostgresOpaqueTelegramSessions,
    [],
  );
  assert.ok(verifier);
  const result = await verifier.verifyBearerToken(token, TENANT);
  assert.equal(received, token);
  assert.equal(result?.tenantId, TENANT);
});

test("tenant verifier treats an Identity token's tenant as a lookup hint", async () => {
  const token = "is_" + "B".repeat(43);
  let receivedTenant = "";
  const verifier = createTenantSessionVerifier(null, [
    {
      verifyBearerTokenForTenant: async (value: string, tenantId: string) => {
        assert.equal(value, token);
        receivedTenant = tenantId;
        return {
          identityId: IDENTITY,
          tenantId,
          expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 60,
          opaqueSessionAuthority: {
            tokenSha256: createHash("sha256").update(value).digest("hex"),
            issuer: "cookie-email",
            audience: "cookie-web",
            kind: "identity" as const,
          },
        };
      },
    } as unknown as IdentitySessions,
  ]);
  assert.ok(verifier);
  const result = await verifier.verifyBearerToken(token, TENANT);
  assert.equal(receivedTenant, TENANT);
  assert.equal(result?.identityId, IDENTITY);
  assert.equal(result?.opaqueSessionAuthority?.kind, "identity");
  assert.equal(await verifier.verifyBearerToken(token, "not-a-tenant"), null);
});

test("no tenant verifier is composed when all auth providers are disabled", () => {
  assert.equal(createTenantSessionVerifier(null, []), null);
});
