import type { PoolClient, QueryResultRow } from "pg";

import {
  createBrandConfig,
  validateBrandConfig,
  type BrandConfigV1,
} from "./branding.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

interface AppearanceRow extends QueryResultRow {
  draft_revision: string;
  draft_config: unknown;
  published_revision: string | null;
  published_config: unknown | null;
  published_at: Date | null;
}

export type AssetKind = "logo" | "background";

export interface TenantAssetOwnership {
  assertOwned(
    client: PoolClient,
    tenantId: string,
    assetId: string,
    kind: AssetKind,
  ): Promise<void>;
}

export interface AppearanceDraft {
  readonly revision: number;
  readonly config: BrandConfigV1;
}

export interface AppearancePublished {
  readonly revision: number;
  readonly config: BrandConfigV1;
  readonly publishedAt: string;
}

export class AppearanceRevisionConflict extends Error {
  constructor() {
    super("Stale Cookie Appearance revision");
    this.name = "AppearanceRevisionConflict";
  }
}

export class AppearanceAssetNotVerified extends Error {
  constructor() {
    super("Tenant appearance asset verification required");
    this.name = "AppearanceAssetNotVerified";
  }
}

function requireTenantId(tenantId: string): void {
  if (!UUID.test(tenantId)) throw new Error("Invalid trusted tenant context");
}

function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Invalid appearance revision");
  }
}

function revisionFromDatabase(raw: string): number {
  const value = Number(raw);
  requireRevision(value);
  return value;
}

/** DB client MUST belong to a caller-owned transaction with trusted policy. */
async function rowForTenant(
  client: PoolClient,
  tenantId: string,
  lock: boolean,
): Promise<AppearanceRow | undefined> {
  const result = await client.query<AppearanceRow>(
    `SELECT draft_revision::text, draft_config,
            published_revision::text, published_config, published_at
       FROM cookie_appearance.organization_branding
      WHERE tenant_id=$1::uuid${lock ? " FOR UPDATE" : ""}`,
    [tenantId],
  );
  return result.rows[0];
}

async function checkAssets(
  client: PoolClient,
  tenantId: string,
  config: BrandConfigV1,
  ownership?: TenantAssetOwnership,
): Promise<void> {
  const candidates: ReadonlyArray<[string | null, AssetKind]> = [
    [config.logoAssetId, "logo"],
    [config.backgroundAssetId, "background"],
  ];
  for (const [assetId, kind] of candidates) {
    if (!assetId) continue;
    // An opaque ID is not proof of ownership. Until the asset module is
    // mounted, refuse to save OR publish drafts referring to unknown assets.
    if (!ownership) throw new AppearanceAssetNotVerified();
    await ownership.assertOwned(client, tenantId, assetId, kind);
  }
}

/** No row means a server default, NOT a persisted/published theme. */
export async function readTenantBrandDraft(
  client: PoolClient,
  tenantId: string,
): Promise<AppearanceDraft> {
  requireTenantId(tenantId);
  const row = await rowForTenant(client, tenantId, false);
  if (!row) return { revision: 0, config: createBrandConfig("atelier") };
  return {
    revision: revisionFromDatabase(row.draft_revision),
    config: validateBrandConfig(row.draft_config),
  };
}

/** Revision-based compare-and-swap; requires a trusted transaction. */
export async function saveTenantBrandDraft(
  client: PoolClient,
  tenantId: string,
  expectedRevision: number,
  rawConfig: unknown,
  ownership?: TenantAssetOwnership,
): Promise<AppearanceDraft> {
  requireTenantId(tenantId);
  requireRevision(expectedRevision);
  const config = validateBrandConfig(rawConfig);
  // Existing rows use the same branding-before-assets lock order as publish.
  const current = await rowForTenant(client, tenantId, true);
  await checkAssets(client, tenantId, config, ownership);
  if (!current) {
    if (expectedRevision !== 0) throw new AppearanceRevisionConflict();
    const inserted = await client.query<{ draft_revision: string }>(
      `INSERT INTO cookie_appearance.organization_branding
         (tenant_id, draft_revision, draft_config)
       VALUES ($1::uuid, 1, $2::jsonb)
       ON CONFLICT (tenant_id) DO NOTHING
       RETURNING draft_revision::text`,
      [tenantId, JSON.stringify(config)],
    );
    if (!inserted.rows[0]) throw new AppearanceRevisionConflict();
    return { revision: 1, config };
  }
  const revision = revisionFromDatabase(current.draft_revision);
  if (revision !== expectedRevision || !Number.isSafeInteger(revision + 1)) {
    throw new AppearanceRevisionConflict();
  }
  const updated = await client.query<{ draft_revision: string }>(
    `UPDATE cookie_appearance.organization_branding
        SET draft_revision=$3::bigint, draft_config=$2::jsonb, updated_at=now()
      WHERE tenant_id=$1::uuid AND draft_revision=$4::bigint
      RETURNING draft_revision::text`,
    [tenantId, JSON.stringify(config), revision + 1, revision],
  );
  if (!updated.rows[0]) throw new AppearanceRevisionConflict();
  return { revision: revision + 1, config };
}

/**
 * Publish the already-saved draft in the same caller-owned transaction.
 * Recheck asset ownership even if the draft was previously accepted:
 * asset authorization may have been revoked between save and publish.
 */
export async function publishTenantBrandDraft(
  client: PoolClient,
  tenantId: string,
  expectedRevision: number,
  ownership?: TenantAssetOwnership,
): Promise<AppearancePublished> {
  requireTenantId(tenantId);
  requireRevision(expectedRevision);
  if (expectedRevision === 0) throw new AppearanceRevisionConflict();

  const current = await rowForTenant(client, tenantId, true);
  if (!current) throw new AppearanceRevisionConflict();
  const revision = revisionFromDatabase(current.draft_revision);
  if (revision !== expectedRevision) throw new AppearanceRevisionConflict();
  const config = validateBrandConfig(current.draft_config);
  await checkAssets(client, tenantId, config, ownership);

  // Publishing a revision twice is idempotent; do not create a new timestamp.
  if (
    current.published_revision !== null &&
    revisionFromDatabase(current.published_revision) === revision &&
    current.published_at
  ) {
    return {
      revision,
      config: validateBrandConfig(current.published_config),
      publishedAt: current.published_at.toISOString(),
    };
  }

  const published = await client.query<{
    published_revision: string;
    published_at: Date;
  }>(
    `UPDATE cookie_appearance.organization_branding
        SET published_revision=draft_revision,
            published_config=draft_config,
            published_at=now(), updated_at=now()
      WHERE tenant_id=$1::uuid AND draft_revision=$2::bigint
      RETURNING published_revision::text, published_at`,
    [tenantId, revision],
  );
  const row = published.rows[0];
  if (!row) throw new AppearanceRevisionConflict();
  return {
    revision: revisionFromDatabase(row.published_revision),
    config,
    publishedAt: row.published_at.toISOString(),
  };
}

/**
 * Public-safe projection. Only an already-published config is returned.
 * Caller MUST resolve salon slug to a publishable tenant server-side;
 * never accept an arbitrary tenant UUID from an anonymous URL as authority.
 */
export async function readPublishedTenantBrand(
  client: PoolClient,
  tenantId: string,
): Promise<AppearancePublished | null> {
  requireTenantId(tenantId);
  const row = await rowForTenant(client, tenantId, false);
  if (!row || row.published_revision === null || !row.published_at) {
    return null;
  }
  return {
    revision: revisionFromDatabase(row.published_revision),
    config: validateBrandConfig(row.published_config),
    publishedAt: row.published_at.toISOString(),
  };
}
