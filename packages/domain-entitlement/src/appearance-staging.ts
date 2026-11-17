import type { PoolClient } from "pg";

export class AppearancePublicationDenied extends Error {
  constructor() {
    super("appearance-grant-unavailable");
    this.name = "AppearancePublicationDenied";
  }
}

/** Caller must hold a real READ COMMITTED protected transaction.
 * Identity/policy locks precede this grant; the grant precedes branding.
 * Never derive this permission from the Staff seat grant or a client field.
 */
export async function lockLiveStagingAppearanceGrant(
  client: PoolClient,
  tenantId: string,
): Promise<string> {
  const locked = await client.query<{ id: string }>(
    `SELECT id::text FROM cookie_entitlement.staging_appearance_grants
      WHERE tenant_id=$1::uuid FOR SHARE`,
    [tenantId],
  );
  const id = locked.rows[0]?.id;
  if (!id) throw new AppearancePublicationDenied();
  // Read DB time in a fresh statement after any lock wait.
  const current = await client.query(
    `SELECT id FROM cookie_entitlement.staging_appearance_grants
      WHERE tenant_id=$1::uuid AND id=$2::uuid
        AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
    [tenantId, id],
  );
  if (current.rowCount !== 1) throw new AppearancePublicationDenied();
  return id;
}
