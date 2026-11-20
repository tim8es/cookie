import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import { IdentitySessions } from "../src/identity-sessions.js";

test("identity sessions reject malformed configuration and tokens before database access", async () => {
  let calls = 0;
  const pool = {
    query: async () => {
      calls++;
      throw new Error("unexpected query");
    },
  } as unknown as Pool;
  assert.throws(() => new IdentitySessions(pool, "", "web", 900));
  assert.throws(() => new IdentitySessions(pool, "issuer", "web", 59));
  assert.throws(() => new IdentitySessions(pool, "issuer", "web", 3601));
  const sessions = new IdentitySessions(pool, "issuer", "web", 900);
  assert.equal(await sessions.resolve("is_bad"), null);
  await sessions.revoke("is_bad");
  await assert.rejects(sessions.issueForVerifiedIdentity("not-a-uuid"));
  assert.equal(calls, 0);
});

test("identity sessions resolve the requested tenant only as a guarded path hint", async () => {
  const identityId = "00000000-0000-4000-8000-000000000001";
  const tenantId = "00000000-0000-4000-8000-000000000002";
  const token = "is_" + "A".repeat(43);
  let queryCount = 0;
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      queryCount += 1;
      assert.equal(values[1], "issuer");
      assert.equal(values[2], "web");
      return {
        rows: [
          {
            identity_id: identityId,
            expires_at: new Date(Date.now() + 60_000),
          },
        ],
      };
    },
  } as unknown as Pool;
  const sessions = new IdentitySessions(pool, "issuer", "web", 900);

  const resolved = await sessions.verifyBearerTokenForTenant(token, tenantId);
  assert.equal(queryCount, 1);
  assert.equal(resolved?.identityId, identityId);
  assert.equal(resolved?.tenantId, tenantId);
  assert.equal(resolved?.opaqueSessionAuthority.kind, "identity");
  assert.equal(
    resolved?.opaqueSessionAuthority.tokenSha256,
    createHash("sha256").update(token).digest("hex"),
  );
  assert.equal(
    await sessions.verifyBearerTokenForTenant("bad", tenantId),
    null,
  );
  assert.equal(
    await sessions.verifyBearerTokenForTenant(token, "invalid"),
    null,
  );
  assert.equal(queryCount, 1);
});
