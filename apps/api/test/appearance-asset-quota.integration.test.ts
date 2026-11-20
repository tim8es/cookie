import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  AppearanceStorageQuotaExceeded,
  storeAppearanceAssetWithinQuota,
} from "../../../packages/appearance-asset-adapter/src/index.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

// Trusted, synthetic 1x1 normalized PNG. This tests quota/SQL locks only,
// NOT native decoding, request admission or public upload security.
const image = {
  bytes: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
    "base64",
  ),
  width: 1,
  height: 1,
};
const oneAsset = { maxAssets: 1, maxBytes: image.bytes.length };

async function requireBlocked(
  pool: Pool,
  waiter: number,
  holder: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Tenant quota advisory lock contention not observed");
}

test(
  "real PG serializes concurrent tenant Appearance quotas, replays and bytes",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-appearance-quota-contention",
      max: 5,
    });
    const identityId = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1::uuid,$3::uuid,'Synthetic quota A'),
               ($2::uuid,$3::uuid,'Synthetic quota B')`,
        [tenantA, tenantB, identityId],
      );

      // Separate real physical clients force a true lock race. The third
      // connection inspects PostgreSQL's actual blocker PID, not JS timing.
      const writer = await pool.connect();
      const competing = await pool.connect();
      const outstanding: Promise<unknown>[] = [];
      try {
        const writerPid = (
          await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        const competingPid = (
          await competing.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid",
          )
        ).rows[0]!.pid;

        await writer.query("BEGIN");
        await competing.query("BEGIN");
        const logo = await storeAppearanceAssetWithinQuota(
          writer,
          tenantA,
          "logo",
          image,
          oneAsset,
        );
        const secondAttempt = storeAppearanceAssetWithinQuota(
          competing,
          tenantA,
          "background",
          image,
          oneAsset,
        ).then(
          (asset) => ({ asset }),
          (error: unknown) => ({ error }),
        );
        outstanding.push(secondAttempt);
        await requireBlocked(pool, competingPid, writerPid);

        // Locks are tenant-scoped: a separate organization must not wait for
        // tenant A's uncommitted quota transaction to finish.
        const separateTenant = await runSqlTransaction(pool, (client) =>
          storeAppearanceAssetWithinQuota(
            client,
            tenantB,
            "logo",
            image,
            oneAsset,
          ),
        );
        assert.equal(separateTenant.kind, "logo");
        await writer.query("COMMIT");
        const conflict = await secondAttempt;
        assert.ok("error" in conflict);
        assert.ok(conflict.error instanceof AppearanceStorageQuotaExceeded);
        await competing.query("ROLLBACK");

        // Even when capacity is exhausted, an exact-content retry in the
        // same tenant/kind must return the original asset, never add a row.
        await writer.query("BEGIN");
        await competing.query("BEGIN");
        const firstReplay = await storeAppearanceAssetWithinQuota(
          writer,
          tenantA,
          "logo",
          image,
          oneAsset,
        );
        const duplicateAttempt = storeAppearanceAssetWithinQuota(
          competing,
          tenantA,
          "logo",
          image,
          oneAsset,
        ).then(
          (asset) => ({ asset }),
          (error: unknown) => ({ error }),
        );
        outstanding.push(duplicateAttempt);
        await requireBlocked(pool, competingPid, writerPid);
        await writer.query("COMMIT");
        const replay = await duplicateAttempt;
        assert.ok("asset" in replay);
        assert.deepEqual(firstReplay, logo);
        assert.deepEqual(replay.asset, logo);
        await competing.query("COMMIT");

        // The byte cap is independently enforced even when the count limit
        // allows a second item. Failed writes must leave no partial row.
        await assert.rejects(
          runSqlTransaction(pool, (client) =>
            storeAppearanceAssetWithinQuota(
              client,
              tenantB,
              "background",
              image,
              { maxAssets: 2, maxBytes: image.bytes.length },
            ),
          ),
          AppearanceStorageQuotaExceeded,
        );
        const result = await pool.query<{
          tenant_id: string;
          count: number;
          bytes: string;
        }>(
          `SELECT tenant_id::text,count(*)::int AS count,
                  sum(octet_length(png_bytes))::text AS bytes
             FROM cookie_appearance.assets
            WHERE tenant_id=ANY($1::uuid[])
            GROUP BY tenant_id ORDER BY tenant_id`,
          [[tenantA, tenantB]],
        );
        assert.deepEqual(
          result.rows.map((row) => ({
            ...row,
            bytes: Number(row.bytes),
          })),
          [tenantA, tenantB].sort().map((tenant_id) => ({
            tenant_id,
            count: 1,
            bytes: image.bytes.length,
          })),
        );

        // These locks/counts assume READ COMMITTED; refuse an unsafe
        // caller-provided snapshot instead of misrepresenting its capacity.
        await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await assert.rejects(
          storeAppearanceAssetWithinQuota(
            writer,
            tenantA,
            "background",
            image,
            oneAsset,
          ),
          /Appearance quota requires READ COMMITTED/,
        );
        await writer.query("ROLLBACK");
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        await Promise.allSettled(outstanding);
        await competing.query("ROLLBACK").catch(() => undefined);
        writer.release();
        competing.release();
      }
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_appearance.assets WHERE tenant_id=ANY($1::uuid[])",
          [[tenantA, tenantB]],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=ANY($1::uuid[])",
          [[tenantA, tenantB]],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [identityId],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
