import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { PostgresOpaqueSessionMaintenance } from "../../../packages/platform-identity/src/opaque-session-maintenance.js";
import { PostgresOpaqueTelegramSessions } from "../../../packages/platform-identity/src/opaque-sessions.js";
import { createTelegramMiniAppProofVerifier } from "../../../packages/platform-identity/src/telegram-init-data.js";

const BOT = "123456789:synthetic_key_NOT_A_REAL_BOT_TOKEN_2026";
const TELEGRAM_ID = 279058397;

function signedInitData(queryId: string): string {
  const fields = {
    query_id: queryId,
    user: JSON.stringify({ id: TELEGRAM_ID, first_name: "Synthetic" }),
    auth_date: String(Math.floor(Date.now() / 1_000)),
  };
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return (
    Object.entries(fields)
      .map(([k, v]) => k + "=" + encodeURIComponent(v))
      .join("&") +
    "&hash=" +
    hash
  );
}

test("opaque retention rejects unsafe deletion windows and unbounded batches", () => {
  const pool = {
    query: () => undefined,
    connect: () => undefined,
  } as unknown as Pool;
  for (const [retentionSeconds, batchSize] of [
    [3_660, 10],
    [7_199, 10],
    [7_200, 0],
    [7_200, 501],
    [Number.NaN, 10],
    [7_200, Number.POSITIVE_INFINITY],
  ]) {
    assert.throws(
      () =>
        new PostgresOpaqueSessionMaintenance({
          pool,
          retentionSeconds,
          batchSize,
        }),
      /Invalid opaque session maintenance configuration/,
    );
  }
  assert.doesNotThrow(
    () =>
      new PostgresOpaqueSessionMaintenance({
        pool,
        retentionSeconds: 7_200,
        batchSize: 1,
      }),
  );
});

test(
  "PostgreSQL opaque cleanup retains fresh proof digests, skips locked rows and deletes only bounded stale sessions",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-f1-opaque-retention",
      max: 4,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const oldA = createHash("sha256").update(randomUUID()).digest();
    const oldB = createHash("sha256").update(randomUUID()).digest();
    const oldActive = createHash("sha256").update(randomUUID()).digest();
    const recentExpired = createHash("sha256").update(randomUUID()).digest();
    let blocker: Awaited<ReturnType<typeof pool.connect>> | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1)",
        [identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES($1,$2,'Synthetic cleanup tenant')",
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1,$2)",
        [tenantId, identityId],
      );
      const insert = async (
        digest: Buffer,
        ageHours: number,
        expired: boolean,
        revoked: boolean,
      ) => {
        await pool.query(
          [
            "INSERT INTO cookie_identity.opaque_sessions",
            "(token_sha256,telegram_exchange_sha256,tenant_id,identity_id,issuer,audience,issued_at,expires_at,revoked_at)",
            "VALUES($1,$2,$3,$4,'synthetic','booking',",
            "clock_timestamp() - $5::int * INTERVAL '1 hour',",
            "clock_timestamp() + $6::int * INTERVAL '30 minutes',",
            "CASE WHEN $7::boolean THEN clock_timestamp() ELSE NULL END)",
          ].join("\n"),
          [
            digest,
            createHash("sha256").update(randomUUID()).digest(),
            tenantId,
            identityId,
            ageHours,
            expired ? -1 : 1,
            revoked,
          ],
        );
      };
      await insert(oldA, 4, true, true);
      await insert(oldB, 3, true, false);
      await insert(oldActive, 4, false, false);
      await insert(recentExpired, 1, true, false);

      const proofVerifier = createTelegramMiniAppProofVerifier({
        botToken: BOT,
        maxAgeSeconds: 600,
      });
      const sessions = new PostgresOpaqueTelegramSessions({
        pool,
        telegramProofVerifier: proofVerifier,
        resolveVerifiedTelegramLink: async () => ({ tenantId, identityId }),
        issuer: "synthetic",
        audience: "booking",
        ttlSeconds: 60,
      });
      const raw = signedInitData("fresh-consumed-hmac");
      const issued = await sessions.exchangeTelegramInitData(raw);
      assert.ok(issued);
      assert.equal(await sessions.revokeBearerToken(issued.bearerToken), true);

      const maintenance = new PostgresOpaqueSessionMaintenance({
        pool,
        retentionSeconds: 7_200,
        batchSize: 1,
      });
      blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT token_sha256 FROM cookie_identity.opaque_sessions WHERE token_sha256=$1 FOR UPDATE",
        [oldA],
      );

      const first = await maintenance.purgeBatch();
      assert.equal(first.deleted, 1, "skip locked old row; make progress");
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.opaque_sessions WHERE token_sha256=$1",
            [oldA],
          )
        ).rowCount,
        1,
        "locked row cannot be prematurely removed",
      );
      await blocker.query("COMMIT");
      blocker.release();
      blocker = undefined;

      assert.equal((await maintenance.purgeBatch()).deleted, 1);
      assert.equal((await maintenance.purgeBatch()).deleted, 0);
      for (const digest of [oldActive, recentExpired]) {
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM cookie_identity.opaque_sessions WHERE token_sha256=$1",
              [digest],
            )
          ).rowCount,
          1,
        );
      }
      assert.equal(
        await sessions.exchangeTelegramInitData(raw),
        null,
        "fresh consumed proof stays unique after revocation and cleanup",
      );
      assert.equal(await sessions.verifyBearerToken(issued.bearerToken), null);
    } finally {
      if (blocker) {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
      await pool
        .query("DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1", [tenantId])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.memberships WHERE tenant_id=$1", [tenantId])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1", [tenantId])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.identities WHERE id=$1", [identityId])
        .catch(() => undefined);
      await pool.end();
    }
  },
);

test(
  "disabled membership deletion is atomic, retention-aware and blocked by foreign keys",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-f1-opaque-member-cleanup",
      max: 4,
    });
    const tenantId = randomUUID();
    const identityId = randomUUID();
    const roleId = randomUUID();
    const assignmentId = randomUUID();
    const maintenance = new PostgresOpaqueSessionMaintenance({
      pool,
      retentionSeconds: 7_200,
      batchSize: 2,
    });
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      assert.deepEqual(
        await maintenance.deleteInactiveMembership(tenantId, identityId),
        { status: "missing", deletedSessions: 0 },
      );
      await assert.rejects(
        maintenance.deleteInactiveMembership("bad-uuid", identityId),
        /Invalid tenant or identity UUID/,
      );
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1)",
        [identityId],
      );
      await pool.query(
        "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES($1,$2,'Synthetic deletion tenant')",
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1,$2)",
        [tenantId, identityId],
      );
      assert.deepEqual(
        await maintenance.deleteInactiveMembership(tenantId, identityId),
        { status: "active", deletedSessions: 0 },
      );

      const sessions = new PostgresOpaqueTelegramSessions({
        pool,
        telegramProofVerifier: createTelegramMiniAppProofVerifier({
          botToken: BOT,
          maxAgeSeconds: 600,
        }),
        resolveVerifiedTelegramLink: async () => ({ tenantId, identityId }),
        issuer: "synthetic",
        audience: "booking",
        ttlSeconds: 60,
      });
      const raw = signedInitData("member-to-remove");
      const issued = await sessions.exchangeTelegramInitData(raw);
      assert.ok(issued);
      await pool.query(
        "UPDATE cookie_identity.memberships SET active=false WHERE tenant_id=$1 AND identity_id=$2",
        [tenantId, identityId],
      );
      assert.equal(await sessions.verifyBearerToken(issued.bearerToken), null);
      assert.deepEqual(
        await maintenance.deleteInactiveMembership(tenantId, identityId),
        { status: "retained", deletedSessions: 0 },
      );
      assert.equal(
        await sessions.exchangeTelegramInitData(raw),
        null,
        "disabled member cannot exchange a retained proof",
      );

      // Simulate passage of DB time in fixtures only, NOT a verifier clock.
      await pool.query(
        [
          "UPDATE cookie_identity.opaque_sessions",
          "SET issued_at=clock_timestamp()-interval '4 hours',",
          "    expires_at=clock_timestamp()-interval '3 hours'",
          "WHERE tenant_id=$1 AND identity_id=$2",
        ].join("\n"),
        [tenantId, identityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name) VALUES($1,$2,'client','Synthetic')",
        [tenantId, roleId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id) VALUES($1,$2,$3,$4)",
        [tenantId, assignmentId, identityId, roleId],
      );
      assert.deepEqual(
        await maintenance.deleteInactiveMembership(tenantId, identityId),
        { status: "blocked-by-dependencies", deletedSessions: 0 },
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.opaque_sessions WHERE tenant_id=$1",
            [tenantId],
          )
        ).rowCount,
        1,
        "FK failure rolls back any session deletion",
      );
      await pool.query(
        "DELETE FROM cookie_identity.role_assignments WHERE tenant_id=$1 AND id=$2",
        [tenantId, assignmentId],
      );
      assert.deepEqual(
        await maintenance.deleteInactiveMembership(tenantId, identityId),
        { status: "deleted", deletedSessions: 1 },
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM cookie_identity.memberships WHERE tenant_id=$1",
            [tenantId],
          )
        ).rowCount,
        0,
      );
      assert.equal(await sessions.exchangeTelegramInitData(raw), null);
    } finally {
      await pool
        .query("DELETE FROM cookie_identity.role_assignments WHERE tenant_id=$1", [tenantId])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.roles WHERE tenant_id=$1", [tenantId])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.opaque_sessions WHERE tenant_id=$1", [tenantId])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.memberships WHERE tenant_id=$1", [tenantId])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1", [tenantId])
        .catch(() => undefined);
      await pool
        .query("DELETE FROM cookie_identity.identities WHERE id=$1", [identityId])
        .catch(() => undefined);
      await pool.end();
    }
  },
);
