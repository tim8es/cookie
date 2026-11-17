import type { PoolClient, QueryResultRow } from "pg";

interface ServicePublicationRow extends QueryResultRow {
  active: boolean;
  draft_revision: number;
}

export type LockedStagingServicePublication =
  | { readonly status: "missing" | "stale" }
  | { readonly status: "ready"; readonly activate: () => Promise<void> };

/**
 * Catalog-owned publication capability. Only an already authorized staging
 * workflow may call this port. The caller owns the open transaction, grant
 * and staff locks, and must complete its assignment checks before activation.
 * Do not retain the returned capability beyond that same transaction.
 */
export async function lockStagingServiceForPublication(
  client: PoolClient,
  tenantId: string,
  serviceId: string,
  expectedRevision: number,
): Promise<LockedStagingServicePublication> {
  const result = await client.query<ServicePublicationRow>(
    "SELECT active,draft_revision FROM cookie_catalog.services WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    [tenantId, serviceId],
  );
  const row = result.rows[0];
  if (!row) return { status: "missing" };
  if (row.draft_revision !== expectedRevision) return { status: "stale" };

  let active = row.active;
  return {
    status: "ready",
    async activate() {
      // An already published shared service is reused, not revised.
      if (active) return;
      await client.query(
        "UPDATE cookie_catalog.services SET active=true,draft_revision=draft_revision+1 WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenantId, serviceId],
      );
      active = true;
    },
  };
}
