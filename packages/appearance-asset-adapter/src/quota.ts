import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type { AssetKind } from "../../domain-appearance/src/index.js";
import {
  storeNormalizedAppearanceAsset,
  type AppearanceAsset,
  type NormalizedAppearanceImage,
} from "./index.js";

export interface AppearanceStorageQuota {
  readonly maxAssets: number;
  readonly maxBytes: number;
}

export class AppearanceStorageQuotaExceeded extends Error {
  constructor() {
    super("appearance-storage-quota");
    this.name = "AppearanceStorageQuotaExceeded";
  }
}

export function validateAppearanceStorageQuota(
  quota: AppearanceStorageQuota,
): AppearanceStorageQuota {
  if (
    !Number.isSafeInteger(quota.maxAssets) ||
    quota.maxAssets < 1 ||
    !Number.isSafeInteger(quota.maxBytes) ||
    quota.maxBytes < 1
  ) {
    throw new Error("Invalid Appearance storage quota");
  }
  return { maxAssets: quota.maxAssets, maxBytes: quota.maxBytes };
}

/** Caller owns a policy-checked READ COMMITTED transaction. All HTTP
 * uploads must use this capability. A tenant-scoped transaction advisory
 * lock serializes quota checks without upgrading Identity's org SHARE lock.
 */
export async function storeAppearanceAssetWithinQuota(
  client: PoolClient,
  tenantId: string,
  kind: AssetKind,
  image: NormalizedAppearanceImage,
  quota: AppearanceStorageQuota,
): Promise<AppearanceAsset> {
  const limits = validateAppearanceStorageQuota(quota);
  const normalized = { ...image, bytes: Buffer.from(image.bytes) };
  const isolation = await client.query<{ transaction_isolation: string }>(
    "SHOW transaction_isolation",
  );
  if (isolation.rows[0]?.transaction_isolation !== "read committed")
    throw new Error("Appearance quota requires READ COMMITTED");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('cookie-appearance-assets:' || $1::uuid::text, 0))",
    [tenantId],
  );
  const sha256 = createHash("sha256").update(normalized.bytes).digest("hex");
  const duplicate = await client.query(
    `SELECT id FROM cookie_appearance.assets
      WHERE tenant_id=$1::uuid AND kind=$2 AND sha256=$3 FOR KEY SHARE`,
    [tenantId, kind, sha256],
  );
  // Identical content does not consume additional capacity, even at quota.
  // The store still verifies the actual bytes, dimensions and digest.
  if (duplicate.rowCount === 0) {
    const result = await client.query<{ count: string; bytes: string }>(
      `SELECT count(*)::text AS count,
              coalesce(sum(octet_length(png_bytes)),0)::text AS bytes
         FROM cookie_appearance.assets WHERE tenant_id=$1::uuid`,
      [tenantId],
    );
    const usage = result.rows[0];
    if (!usage) throw new Error("Appearance quota usage unavailable");
    if (
      BigInt(usage.count) + 1n > BigInt(limits.maxAssets) ||
      BigInt(usage.bytes) + BigInt(normalized.bytes.length) >
        BigInt(limits.maxBytes)
    ) {
      throw new AppearanceStorageQuotaExceeded();
    }
  }
  return storeNormalizedAppearanceAsset(client, tenantId, kind, normalized);
}
