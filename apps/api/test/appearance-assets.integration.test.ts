import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import {
  AppearanceAssetNotVerified,
  createBrandConfig,
  publishTenantBrandDraft,
  saveTenantBrandDraft,
} from "../../../packages/domain-appearance/src/index.js";
import {
  AppearanceAssetReferenced,
  deleteUnusedAppearanceAsset,
  postgresAppearanceAssetOwnership,
  readTenantAppearanceAsset,
  storeNormalizedAppearanceAsset,
} from "../../../packages/appearance-asset-adapter/src/index.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

// Synthetic 1x1 PNG fixture; not an assertion of upload codec safety.
const image = {
  bytes: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
    "base64",
  ),
  width: 1,
  height: 1,
};

async function waitForBlocked(
  pool: Pool,
  pid: number,
  blocker: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked",
      [pid, blocker],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected asset lock contention was not observed");
}

test(
  "PostgreSQL stores normalized Appearance assets by tenant and kind and preserves referenced bytes",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-appearance-assets-test",
      max: 4,
    });
    const owner = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const tx = <T>(work: (client: PoolClient) => Promise<T>) =>
      runSqlTransaction<T>(pool, work);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
         VALUES($1::uuid,$3::uuid,'Synthetic asset A'),
               ($2::uuid,$3::uuid,'Synthetic asset B')`,
        [tenantA, tenantB, owner],
      );
      const [logo, duplicate] = await Promise.all([
        tx((client) =>
          storeNormalizedAppearanceAsset(client, tenantA, "logo", image),
        ),
        tx((client) =>
          storeNormalizedAppearanceAsset(client, tenantA, "logo", image),
        ),
      ]);
      assert.deepEqual(duplicate, logo);
      const foreign = await tx((client) =>
        storeNormalizedAppearanceAsset(client, tenantB, "logo", image),
      );
      const background = await tx((client) =>
        storeNormalizedAppearanceAsset(client, tenantA, "background", image),
      );
      assert.notEqual(foreign.id, logo.id);
      assert.notEqual(background.id, logo.id);

      const read = await tx((client) =>
        readTenantAppearanceAsset(client, tenantA, logo.id, "logo"),
      );
      assert.deepEqual(read, { ...logo, bytes: image.bytes });
      assert.equal(
        await tx((client) =>
          readTenantAppearanceAsset(client, tenantB, logo.id, "logo"),
        ),
        null,
      );
      assert.equal(
        await tx((client) =>
          readTenantAppearanceAsset(client, tenantA, logo.id, "background"),
        ),
        null,
      );
      assert.equal(
        await tx((client) =>
          deleteUnusedAppearanceAsset(client, tenantB, logo.id, "logo"),
        ),
        false,
      );
      await assert.rejects(
        tx((client) =>
          storeNormalizedAppearanceAsset(client, tenantA, "logo", {
            ...image,
            width: 2,
          }),
        ),
        /Invalid normalized/,
      );
      const config = {
        ...createBrandConfig("forest"),
        logoAssetId: logo.id.toUpperCase(),
      };
      await assert.rejects(
        tx((client) =>
          saveTenantBrandDraft(
            client,
            tenantB,
            0,
            config,
            postgresAppearanceAssetOwnership,
          ),
        ),
        AppearanceAssetNotVerified,
      );
      await assert.rejects(
        tx((client) =>
          saveTenantBrandDraft(
            client,
            tenantA,
            0,
            { ...config, logoAssetId: background.id },
            postgresAppearanceAssetOwnership,
          ),
        ),
        AppearanceAssetNotVerified,
      );
      await tx((client) =>
        saveTenantBrandDraft(
          client,
          tenantA,
          0,
          config,
          postgresAppearanceAssetOwnership,
        ),
      );
      await assert.rejects(
        tx((client) =>
          deleteUnusedAppearanceAsset(client, tenantA, logo.id, "logo"),
        ),
        AppearanceAssetReferenced,
      );
      await tx((client) =>
        publishTenantBrandDraft(
          client,
          tenantA,
          1,
          postgresAppearanceAssetOwnership,
        ),
      );
      await tx((client) =>
        saveTenantBrandDraft(
          client,
          tenantA,
          1,
          createBrandConfig("ocean"),
          postgresAppearanceAssetOwnership,
        ),
      );
      await assert.rejects(
        tx((client) =>
          deleteUnusedAppearanceAsset(client, tenantA, logo.id, "logo"),
        ),
        AppearanceAssetReferenced,
      );
      await tx((client) =>
        publishTenantBrandDraft(
          client,
          tenantA,
          2,
          postgresAppearanceAssetOwnership,
        ),
      );
      assert.equal(
        await tx((client) =>
          deleteUnusedAppearanceAsset(client, tenantA, logo.id, "logo"),
        ),
        true,
      );
      assert.equal(
        await tx((client) =>
          deleteUnusedAppearanceAsset(client, tenantA, logo.id, "logo"),
        ),
        false,
      );
      await assert.rejects(
        tx((client) =>
          saveTenantBrandDraft(
            client,
            tenantA,
            2,
            config,
            postgresAppearanceAssetOwnership,
          ),
        ),
        AppearanceAssetNotVerified,
      );
      // Initial save has no branding row to lock yet. It must still protect
      // the asset until COMMIT, including during concurrent deletion.
      const writer = await pool.connect();
      const deleter = await pool.connect();
      try {
        await writer.query("BEGIN");
        await deleter.query("BEGIN");
        const writerPid = await writer.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const deleterPid = await deleter.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        await saveTenantBrandDraft(
          writer,
          tenantB,
          0,
          { ...createBrandConfig("forest"), logoAssetId: foreign.id },
          postgresAppearanceAssetOwnership,
        );
        const deletion = deleteUnusedAppearanceAsset(
          deleter,
          tenantB,
          foreign.id,
          "logo",
        ).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await waitForBlocked(
            pool,
            deleterPid.rows[0]!.pid,
            writerPid.rows[0]!.pid,
          );
          await writer.query("COMMIT");
          const outcome = await deletion;
          assert.ok("error" in outcome);
          assert.ok(outcome.error instanceof AppearanceAssetReferenced);
        } finally {
          await writer.query("ROLLBACK");
          await deletion;
        }
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        await deleter.query("ROLLBACK").catch(() => undefined);
        writer.release();
        deleter.release();
      }
      // Reverse order: a committed deletion must not leave a dangling draft
      // reference. Prove actual lock contention rather than relying on timing.
      const deleteFirst = await pool.connect();
      const saveSecond = await pool.connect();
      try {
        await deleteFirst.query("BEGIN");
        await saveSecond.query("BEGIN");
        const firstPid = await deleteFirst.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const secondPid = await saveSecond.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        assert.equal(
          await deleteUnusedAppearanceAsset(
            deleteFirst,
            tenantA,
            background.id,
            "background",
          ),
          true,
        );
        const saving = saveTenantBrandDraft(
          saveSecond,
          tenantA,
          2,
          { ...createBrandConfig("clay"), backgroundAssetId: background.id },
          postgresAppearanceAssetOwnership,
        ).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await waitForBlocked(
            pool,
            secondPid.rows[0]!.pid,
            firstPid.rows[0]!.pid,
          );
          await deleteFirst.query("COMMIT");
          const outcome = await saving;
          assert.ok("error" in outcome);
          assert.ok(outcome.error instanceof AppearanceAssetNotVerified);
        } finally {
          await deleteFirst.query("ROLLBACK");
          await saving;
        }
        await saveSecond.query("ROLLBACK");
        const persisted = await pool.query(
          `SELECT draft_revision::text,published_revision::text,
                  draft_config->>'backgroundAssetId' AS background
             FROM cookie_appearance.organization_branding
            WHERE tenant_id=$1::uuid`,
          [tenantA],
        );
        assert.deepEqual(persisted.rows, [
          { draft_revision: "2", published_revision: "2", background: null },
        ]);
      } finally {
        await deleteFirst.query("ROLLBACK").catch(() => undefined);
        await saveSecond.query("ROLLBACK").catch(() => undefined);
        deleteFirst.release();
        saveSecond.release();
      }
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_appearance.organization_branding WHERE tenant_id=ANY($1::uuid[])",
          [[tenantA, tenantB]],
        );
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
          [owner],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
