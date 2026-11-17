import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import {
  AppearanceAssetNotVerified,
  AppearanceRevisionConflict,
  createBrandConfig,
  publishTenantBrandDraft,
  readPublishedTenantBrand,
  readTenantBrandDraft,
  saveTenantBrandDraft,
  type TenantAssetOwnership,
} from "../../../packages/domain-appearance/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;
    const result = await work(client);
    await client.query("COMMIT");
    active = false;
    return result;
  } catch (error) {
    if (active) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test(
  "real PostgreSQL Appearance drafts and published themes stay tenant-scoped and revisioned",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-appearance-integration",
      max: 6,
    });
    const owner = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
         VALUES($1::uuid,$3::uuid,'Synthetic appearance A'),
               ($2::uuid,$3::uuid,'Synthetic appearance B')`,
        [tenantA, tenantB, owner],
      );

      const initial = await transaction(pool, (client) =>
        readTenantBrandDraft(client, tenantA),
      );
      assert.equal(initial.revision, 0);
      assert.equal(initial.config.presetId, "atelier");
      assert.equal(
        await transaction(pool, (client) =>
          readPublishedTenantBrand(client, tenantA),
        ),
        null,
        "Default never implies a published page",
      );

      const saved = await transaction(pool, (client) =>
        saveTenantBrandDraft(client, tenantA, 0, createBrandConfig("forest")),
      );
      assert.equal(saved.revision, 1);
      assert.equal(saved.config.mode, "dark");
      assert.equal(
        await transaction(pool, (client) =>
          readPublishedTenantBrand(client, tenantA),
        ),
        null,
        "A saved draft must stay private until publish",
      );

      await assert.rejects(
        transaction(pool, (client) =>
          saveTenantBrandDraft(client, tenantA, 0, createBrandConfig("clay")),
        ),
        AppearanceRevisionConflict,
      );

      const published = await transaction(pool, (client) =>
        publishTenantBrandDraft(client, tenantA, 1),
      );
      assert.equal(published.revision, 1);
      assert.equal(published.config.presetId, "forest");
      assert.ok(Number.isFinite(Date.parse(published.publishedAt)));

      const replay = await transaction(pool, (client) =>
        publishTenantBrandDraft(client, tenantA, 1),
      );
      assert.deepEqual(replay, published, "Repeat publication is idempotent");

      const updated = await transaction(pool, (client) =>
        saveTenantBrandDraft(client, tenantA, 1, createBrandConfig("ocean")),
      );
      assert.equal(updated.revision, 2);
      assert.equal(updated.config.mode, "light");
      assert.equal(
        (
          await transaction(pool, (client) =>
            readPublishedTenantBrand(client, tenantA),
          )
        )?.config.presetId,
        "forest",
        "Existing published revision remains stable during private editing",
      );

      await assert.rejects(
        transaction(pool, (client) =>
          publishTenantBrandDraft(client, tenantA, 1),
        ),
        AppearanceRevisionConflict,
      );
      const second = await transaction(pool, (client) =>
        publishTenantBrandDraft(client, tenantA, 2),
      );
      assert.equal(second.config.presetId, "ocean");

      // A different tenant has its own default and public publication state.
      assert.equal(
        (
          await transaction(pool, (client) =>
            readTenantBrandDraft(client, tenantB),
          )
        ).revision,
        0,
      );
      assert.equal(
        await transaction(pool, (client) =>
          readPublishedTenantBrand(client, tenantB),
        ),
        null,
      );

      // A server rollback must not leak an edited theme to another connection.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const transient = await saveTenantBrandDraft(
          client,
          tenantB,
          0,
          createBrandConfig("clay"),
        );
        assert.equal(transient.revision, 1);
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      assert.equal(
        (await transaction(pool, (db) => readTenantBrandDraft(db, tenantB)))
          .revision,
        0,
      );

      // One of two concurrent updates of revision 2 wins, never both.
      const writers = await Promise.allSettled([
        transaction(pool, (db) =>
          saveTenantBrandDraft(db, tenantA, 2, createBrandConfig("atelier")),
        ),
        transaction(pool, (db) =>
          saveTenantBrandDraft(db, tenantA, 2, createBrandConfig("clay")),
        ),
      ]);
      assert.equal(
        writers.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        writers.filter(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof AppearanceRevisionConflict,
        ).length,
        1,
      );
      assert.equal(
        (await transaction(pool, (db) => readTenantBrandDraft(db, tenantA)))
          .revision,
        3,
      );
      assert.equal(
        (await transaction(pool, (db) => readPublishedTenantBrand(db, tenantA)))
          ?.revision,
        2,
        "Concurrent draft edit does not auto-publish",
      );

      // References to images are not proof that the asset belongs to tenant A.
      const logoAssetId = "safeTenantAsset_15charsAtLeast";
      const withLogo = {
        ...createBrandConfig("atelier"),
        logoAssetId,
      };
      await assert.rejects(
        transaction(pool, (db) =>
          saveTenantBrandDraft(db, tenantB, 0, withLogo),
        ),
        AppearanceAssetNotVerified,
      );
      const ownership: TenantAssetOwnership = {
        async assertOwned(_db, tenantId, assetId, kind) {
          assert.equal(tenantId, tenantB);
          assert.equal(assetId, logoAssetId);
          assert.equal(kind, "logo");
        },
      };
      await transaction(pool, (db) =>
        saveTenantBrandDraft(db, tenantB, 0, withLogo, ownership),
      );
      await assert.rejects(
        transaction(pool, (db) => publishTenantBrandDraft(db, tenantB, 1)),
        AppearanceAssetNotVerified,
      );
      assert.equal(
        await transaction(pool, (db) => readPublishedTenantBrand(db, tenantB)),
        null,
      );
      assert.equal(
        (
          await transaction(pool, (db) =>
            publishTenantBrandDraft(db, tenantB, 1, ownership),
          )
        ).revision,
        1,
      );

      await assert.rejects(
        transaction(pool, (db) =>
          saveTenantBrandDraft(db, tenantA, 3, {
            ...createBrandConfig("ocean"),
            accentColor: "url(https://evil.invalid)",
          }),
        ),
        /Invalid accentColor/,
      );
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_appearance.organization_branding WHERE tenant_id = ANY($1::uuid[])",
          [[tenantA, tenantB]],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id = ANY($1::uuid[])",
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
