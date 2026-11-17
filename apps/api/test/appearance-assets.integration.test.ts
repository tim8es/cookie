import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import {
  AppearanceAssetNotVerified,
  AppearanceAssetReferenced,
  createBrandConfig,
  deleteUnusedAppearanceAsset,
  postgresAppearanceAssetOwnership,
  publishTenantBrandDraft,
  readTenantAppearanceAsset,
  saveTenantBrandDraft,
  storeNormalizedAppearanceAsset,
} from "../../../packages/domain-appearance/src/index.js";
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
        logoAssetId: logo.id,
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
