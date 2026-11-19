import type { PoolClient } from "pg";

import type { AppearancePublished } from "./postgres.js";

/** The caller owns the protected transaction, live grant and authorization.
 * Write only the successful publication's minimal audit. Repeating a
 * revision preserves the original audit row; no separate commit or pool.
 */
export async function recordAppearancePublicationAudit(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly grantId: string;
    readonly actorIdentityId: string;
    readonly correlationId: string;
    readonly published: Pick<AppearancePublished, "revision" | "publishedAt">;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO cookie_appearance.publication_audit
       (tenant_id,revision,grant_id,actor_identity_id,correlation_id,published_at)
     VALUES($1::uuid,$2::bigint,$3::uuid,$4::uuid,$5,$6::timestamptz)
     ON CONFLICT (tenant_id,revision) DO NOTHING`,
    [
      input.tenantId,
      input.published.revision,
      input.grantId,
      input.actorIdentityId,
      input.correlationId,
      input.published.publishedAt,
    ],
  );
}
