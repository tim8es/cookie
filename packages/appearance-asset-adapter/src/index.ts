import { createHash, randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import {
  AppearanceAssetNotVerified,
  type AssetKind,
  type TenantAssetOwnership,
} from "../../domain-appearance/src/index.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

/**
 * Output of a trusted bounded server-side image codec, NOT an upload DTO.
 * These structural checks are defense in depth; they do not decode pixels,
 * sanitize metadata or make arbitrary client bytes safe.
 */
export interface NormalizedAppearanceImage {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

export interface AppearanceAsset {
  readonly id: string;
  readonly kind: AssetKind;
  readonly mime: "image/png";
  readonly width: number;
  readonly height: number;
}

interface AssetRow extends QueryResultRow {
  id: string;
  kind: AssetKind;
  sha256: string;
  width: number;
  height: number;
  png_bytes: Buffer;
}

export class AppearanceAssetReferenced extends Error {
  constructor() {
    super("Appearance asset is referenced");
    this.name = "AppearanceAssetReferenced";
  }
}

function validScope(tenantId: string, kind: AssetKind): boolean {
  return UUID.test(tenantId) && (kind === "logo" || kind === "background");
}

function validateNormalized(
  image: NormalizedAppearanceImage,
): NormalizedAppearanceImage {
  const { bytes, width, height } = image;
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 33 ||
    bytes.length > 2 * 1024 * 1024 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  ) {
    throw new Error("Invalid normalized Appearance image");
  }
  // Copy caller-owned bytes before awaiting any database work.
  return { bytes: Buffer.from(bytes), width, height };
}

function metadata(row: AssetRow): AppearanceAsset {
  return {
    id: row.id,
    kind: row.kind,
    mime: "image/png",
    width: row.width,
    height: row.height,
  };
}

/** Caller supplies a trusted tenant and a policy-checked transaction. */
export async function storeNormalizedAppearanceAsset(
  client: PoolClient,
  tenantId: string,
  kind: AssetKind,
  image: NormalizedAppearanceImage,
): Promise<AppearanceAsset> {
  if (!validScope(tenantId, kind)) throw new AppearanceAssetNotVerified();
  const normalized = validateNormalized(image);
  const sha256 = createHash("sha256").update(normalized.bytes).digest("hex");
  await client.query(
    `INSERT INTO cookie_appearance.assets
       (id, tenant_id, kind, sha256, width, height, png_bytes)
     VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, kind, sha256) DO NOTHING`,
    [
      randomUUID(),
      tenantId,
      kind,
      sha256,
      normalized.width,
      normalized.height,
      normalized.bytes,
    ],
  );
  const result = await client.query<AssetRow>(
    `SELECT id::text, kind, sha256, width, height, png_bytes
       FROM cookie_appearance.assets
      WHERE tenant_id=$1::uuid AND kind=$2 AND sha256=$3
      FOR KEY SHARE`,
    [tenantId, kind, sha256],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.width !== normalized.width ||
    row.height !== normalized.height ||
    !row.png_bytes.equals(normalized.bytes)
  ) {
    throw new Error("Appearance asset storage mismatch");
  }
  return metadata(row);
}

/** Use this exact port inside save/publish, never a client-supplied asset ID. */
export const postgresAppearanceAssetOwnership: TenantAssetOwnership =
  Object.freeze({
    async assertOwned(
      client: PoolClient,
      tenantId: string,
      assetId: string,
      kind: AssetKind,
    ): Promise<void> {
      if (!validScope(tenantId, kind) || !UUID.test(assetId))
        throw new AppearanceAssetNotVerified();
      const result = await client.query(
        `SELECT id FROM cookie_appearance.assets
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND kind=$3
          FOR KEY SHARE`,
        [tenantId, assetId, kind],
      );
      if (result.rowCount !== 1) throw new AppearanceAssetNotVerified();
    },
  });

/** Private capability only; no authorization or public slug resolution here. */
export async function readTenantAppearanceAsset(
  client: PoolClient,
  tenantId: string,
  assetId: string,
  kind: AssetKind,
): Promise<(AppearanceAsset & { readonly bytes: Buffer }) | null> {
  if (!validScope(tenantId, kind) || !UUID.test(assetId)) return null;
  const result = await client.query<AssetRow>(
    `SELECT id::text, kind, sha256, width, height, png_bytes
       FROM cookie_appearance.assets
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND kind=$3`,
    [tenantId, assetId, kind],
  );
  const row = result.rows[0];
  if (!row) return null;
  const image = validateNormalized({
    bytes: row.png_bytes,
    width: row.width,
    height: row.height,
  });
  if (createHash("sha256").update(image.bytes).digest("hex") !== row.sha256)
    throw new Error("Appearance asset storage mismatch");
  return { ...metadata(row), bytes: image.bytes };
}

/**
 * Under READ COMMITTED, lock the asset before reading both stored configs.
 * Save/publish must hold FOR KEY SHARE through commit. Whichever operation
 * wins the asset lock determines the result. Never lock the branding row
 * here: a draft writer may already own it and be waiting for the asset.
 */
export async function deleteUnusedAppearanceAsset(
  client: PoolClient,
  tenantId: string,
  assetId: string,
  kind: AssetKind,
): Promise<boolean> {
  if (!validScope(tenantId, kind) || !UUID.test(assetId)) return false;
  const isolation = await client.query<{ transaction_isolation: string }>(
    "SHOW transaction_isolation",
  );
  if (isolation.rows[0]?.transaction_isolation !== "read committed")
    throw new Error("Appearance asset deletion requires READ COMMITTED");
  const locked = await client.query(
    `SELECT id FROM cookie_appearance.assets
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND kind=$3
      FOR UPDATE`,
    [tenantId, assetId, kind],
  );
  if (locked.rowCount !== 1) return false;
  const referenced = await client.query(
    `SELECT tenant_id FROM cookie_appearance.organization_branding
      WHERE tenant_id=$1::uuid AND (
        lower(draft_config->>'logoAssetId')=lower($2) OR
        lower(draft_config->>'backgroundAssetId')=lower($2) OR
        lower(published_config->>'logoAssetId')=lower($2) OR
        lower(published_config->>'backgroundAssetId')=lower($2)
      )`,
    [tenantId, assetId],
  );
  if (referenced.rowCount !== 0) throw new AppearanceAssetReferenced();
  const deleted = await client.query(
    `DELETE FROM cookie_appearance.assets
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND kind=$3`,
    [tenantId, assetId, kind],
  );
  if (deleted.rowCount !== 1) throw new Error("Appearance asset delete failed");
  return true;
}

export { AppearanceCodecFailure, normalizeAppearanceImage } from "./codec.js";
export type { AppearanceCodecFailureCode } from "./codec.js";
