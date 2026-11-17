import assert from "node:assert/strict";
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
