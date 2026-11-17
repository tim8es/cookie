import type { Pool, PoolClient } from "pg";

import {
  AuthorizationDeniedError,
  requireTenantPermission,
  type TrustedActor,
} from "../../../packages/platform-identity/src/index.js";

/**
 * Single transaction for owner policy, bearer/link locks, and business changes.
 * Revoked privileges cannot commit between policy check and the command.
 * Non-sensitive denials are audited before commit; business failures roll back.
 */
export async function withTenantPermission<T>(
  pool: Pool,
  actor: TrustedActor,
  permission: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  let businessStarted = false;
  try {
    await client.query("BEGIN");
    active = true;
    await requireTenantPermission(
      client,
      actor,
      { kind: "organization", tenantId: actor.tenantId },
      permission,
    );
    businessStarted = true;
    const result = await work(client);
    await client.query("COMMIT");
    active = false;
    return result;
  } catch (reason) {
    if (active) {
      if (reason instanceof AuthorizationDeniedError && !businessStarted) {
        await client.query("COMMIT").catch(() => undefined);
      } else {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    }
    throw reason;
  } finally {
    client.release();
  }
}
