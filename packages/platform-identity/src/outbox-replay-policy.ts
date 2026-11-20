import type { PoolClient } from "pg";

import {
  requireSensitiveAuthorization,
  type TrustedActor,
} from "./authorization.js";
import { loadPolicySnapshot, PostgresPolicyAudit } from "./postgres.js";

/**
 * Trusted, transaction-scoped authorization for manual outbox replay.
 * The caller owns the PostgreSQL transaction and performs the mutation only
 * after this preflight. The policy snapshot and its audit use the same client;
 * this port never verifies a bearer or exposes an HTTP capability.
 *
 * Preserve the existing SERIALIZABLE replay contract. In particular, this
 * helper must not open a second transaction or swallow an audit failure.
 */
export async function authorizeOutboxReplay(
  client: PoolClient,
  actor: TrustedActor,
): Promise<void> {
  const snapshot = await loadPolicySnapshot(client, actor);
  await requireSensitiveAuthorization(
    {
      actor,
      resource: { kind: "organization", tenantId: actor.tenantId },
      permission: "outbox.replay",
      ownerProtected: true,
    },
    snapshot,
    new PostgresPolicyAudit(client),
  );
}
