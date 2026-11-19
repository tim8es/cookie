import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/transaction.js";
import { RefreshSessionFamilies } from "../../../packages/platform-identity/src/refresh-session-families.js";

const digest = (token: string) => createHash("sha256").update(token).digest();

test(
  "refresh families rotate once, expire, and revoke on replay without access issuance",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
    const identityId = randomUUID();
    const transaction = <T>(work: Parameters<typeof runSqlTransaction<T>>[1]) =>
      runSqlTransaction(pool, work);
    const policy = { idleSeconds: 120, absoluteSeconds: 300 };
    const families = new RefreshSessionFamilies(
      transaction,
      "refresh-test",
      "web",
      policy,
    );
    const other = new RefreshSessionFamilies(
      transaction,
      "refresh-test",
      "other",
      policy,
    );
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      const first = await families.createForVerifiedIdentity(identityId);
      const independent = await families.createForVerifiedIdentity(identityId);
      assert.match(first.refreshToken, /^ir_[A-Za-z0-9_-]{43}$/);
      assert.notEqual(first.refreshToken, independent.refreshToken);
      assert.deepEqual(await other.rotate(first.refreshToken), {
        status: "denied",
      });
      await other.revoke(first.refreshToken);
      assert.deepEqual(await families.rotate("is_" + "x".repeat(43)), {
        status: "denied",
      });
      const stored = await pool.query(
        "SELECT token_sha256 FROM cookie_identity.refresh_session_credentials WHERE token_sha256=$1",
        [digest(first.refreshToken)],
      );
      assert.equal(stored.rowCount, 1);
      const next = await families.rotate(first.refreshToken);
      assert.equal(next.status, "rotated");
      assert.ok(next.status === "rotated");
      assert.notEqual(next.refreshToken, first.refreshToken);
      assert.equal(next.identityId, identityId);
      assert.deepEqual(await families.rotate(first.refreshToken), {
        status: "replayed",
      });
      assert.deepEqual(await families.rotate(next.refreshToken), {
        status: "denied",
      });

      const concurrent = await Promise.all([
        families.rotate(independent.refreshToken),
        families.rotate(independent.refreshToken),
      ]);
      assert.deepEqual(concurrent.map((r) => r.status).sort(), [
        "replayed",
        "rotated",
      ]);
      for (const row of concurrent) {
        if (row.status === "rotated")
          assert.deepEqual(await families.rotate(row.refreshToken), {
            status: "denied",
          });
      }

      const logout = await families.createForVerifiedIdentity(identityId);
      const rotated = await families.rotate(logout.refreshToken);
      assert.ok(rotated.status === "rotated");
      await families.revoke(logout.refreshToken);
      await families.revoke(logout.refreshToken);
      assert.deepEqual(await families.rotate(rotated.refreshToken), {
        status: "denied",
      });

      const expiry = await families.createForVerifiedIdentity(identityId);
      await pool.query(
        `UPDATE cookie_identity.refresh_session_families
         SET created_at=clock_timestamp()-interval '200 seconds',
             idle_expires_at=clock_timestamp()-interval '1 second'
         WHERE id=(SELECT family_id FROM cookie_identity.refresh_session_credentials
                   WHERE token_sha256=$1)`,
        [digest(expiry.refreshToken)],
      );
      assert.deepEqual(await families.rotate(expiry.refreshToken), {
        status: "denied",
      });
      const cap = await families.createForVerifiedIdentity(identityId);
      await pool.query(
        `UPDATE cookie_identity.refresh_session_families
         SET absolute_expires_at=clock_timestamp()+interval '10 seconds',
             idle_expires_at=clock_timestamp()+interval '5 seconds'
         WHERE id=(SELECT family_id FROM cookie_identity.refresh_session_credentials
                   WHERE token_sha256=$1)`,
        [digest(cap.refreshToken)],
      );
      const capped = await families.rotate(cap.refreshToken);
      assert.ok(capped.status === "rotated");
      const boundary = await pool.query(
        `SELECT f.idle_expires_at=f.absolute_expires_at AS capped
         FROM cookie_identity.refresh_session_families f
         JOIN cookie_identity.refresh_session_credentials c ON c.family_id=f.id
         WHERE c.token_sha256=$1`,
        [digest(capped.refreshToken)],
      );
      assert.deepEqual(boundary.rows, [{ capped: true }]);
      const rollback = await families.createForVerifiedIdentity(identityId);
      await assert.rejects(
        transaction(async (client) => {
          const nested = new RefreshSessionFamilies(
            async (work) => work(client),
            "refresh-test",
            "web",
            policy,
          );
          assert.equal(
            (await nested.rotate(rollback.refreshToken)).status,
            "rotated",
          );
          throw new Error("synthetic refresh rollback");
        }),
        /synthetic refresh rollback/,
      );
      assert.equal(
        (await families.rotate(rollback.refreshToken)).status,
        "rotated",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
            [identityId],
          )
        ).rowCount,
        0,
      );
    } finally {
      await pool.query(
        `DELETE FROM cookie_identity.refresh_session_credentials
         WHERE family_id IN (SELECT id FROM cookie_identity.refresh_session_families
                             WHERE identity_id=$1::uuid)`,
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.refresh_session_families WHERE identity_id=$1::uuid",
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
