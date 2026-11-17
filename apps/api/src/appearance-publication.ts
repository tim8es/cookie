import type { PoolClient } from "pg";

import {
  publishTenantBrandDraft,
  type AppearancePublished,
  type TenantAssetOwnership,
} from "../../../packages/domain-appearance/src/index.js";
import {
  AppearancePublicationDenied,
  lockLiveStagingAppearanceGrant,
} from "../../../packages/domain-entitlement/src/index.js";
import type { TrustedActor } from "../../../packages/platform-identity/src/index.js";

/** This is a staging command, not a commercial or public authority. The
 * caller owns the protected transaction and current appearance.publish role.
 */
export async function publishAppearanceWithStagingGrant(
  client: PoolClient,
  actor: TrustedActor,
  expectedRevision: number,
  assets?: TenantAssetOwnership,
): Promise<AppearancePublished> {
  if (!actor.opaqueSessionAuthority) throw new AppearancePublicationDenied();
  const grantId = await lockLiveStagingAppearanceGrant(client, actor.tenantId);
  const published = await publishTenantBrandDraft(
    client,
    actor.tenantId,
    expectedRevision,
    assets,
  );
  // A repeated publication is idempotent, including its audit record.
  await client.query(
    `INSERT INTO cookie_appearance.publication_audit
       (tenant_id,revision,grant_id,actor_identity_id,correlation_id,published_at)
     VALUES($1::uuid,$2::bigint,$3::uuid,$4::uuid,$5,$6::timestamptz)
     ON CONFLICT (tenant_id,revision) DO NOTHING`,
    [
      actor.tenantId,
      published.revision,
      grantId,
      actor.identityId,
      actor.correlationId,
      published.publishedAt,
    ],
  );
  const current = await lockLiveStagingAppearanceGrant(client, actor.tenantId);
  if (current !== grantId) throw new AppearancePublicationDenied();
  return published;
}
