import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/identity-sessions.js";

test(
  "pre-organization identity sessions are scoped, opaque, expiring and revocable",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 2,
    });
    const identityId = randomUUID();
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      const sessions = new IdentitySessions(
        pool,
        "test-issuer",
        "test-web",
        60,
      );
      const otherAudience = new IdentitySessions(
        pool,
        "test-issuer",
        "other-web",
        60,
      );
      const first = await sessions.issueForVerifiedIdentity(identityId);
      const second = await sessions.issueForVerifiedIdentity(identityId);
      assert.notEqual(first.token, second.token);
      assert.match(first.token, /^is_[A-Za-z0-9_-]{43}$/);
      assert.equal(await sessions.resolve(first.token), identityId);
      assert.equal(await otherAudience.resolve(first.token), null);
      assert.equal(await sessions.resolve("malformed"), null);
      await otherAudience.revoke(first.token);
      assert.equal(await sessions.resolve(first.token), identityId);
      const tokenHash = createHash("sha256").update(first.token).digest();
      const stored = await pool.query(
        "SELECT token_sha256 FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
        [identityId],
      );
      assert.equal(stored.rowCount, 2);
      assert.ok(
        stored.rows.some((row) =>
          (row.token_sha256 as Buffer).equals(tokenHash),
        ),
      );
      await sessions.revoke(first.token);
      await sessions.revoke(first.token);
      assert.equal(await sessions.resolve(first.token), null);
      assert.equal(await sessions.resolve(second.token), identityId);
      await pool.query(
        "UPDATE cookie_identity.identity_sessions SET expires_at=clock_timestamp()-interval '1 second', issued_at=clock_timestamp()-interval '1 hour' WHERE token_sha256=$1",
        [createHash("sha256").update(second.token).digest()],
      );
      assert.equal(await sessions.resolve(second.token), null);
      await assert.rejects(sessions.issueForVerifiedIdentity(randomUUID()));
    } finally {
      await pool.query(
        "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
        [identityId],
      );
      await pool.end();
    }
  },
);
