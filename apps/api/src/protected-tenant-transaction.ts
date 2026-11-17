import type { Pool, PoolClient } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";

import {
  AuthorizationDeniedError,
  requireTenantPermission,
  type TrustedActor,
} from "../../../packages/platform-identity/src/index.js";

/** A failed close must never return an uncertain transaction to the pool. */
export async function runProtectedTransaction<T>(
  pool: Pool,
  authorize: (client: PoolClient) => Promise<void>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const outcome = await runSqlTransaction(
    pool,
    async (
      client,
    ): Promise<
      | { allowed: true; value: T }
      | { allowed: false; reason: AuthorizationDeniedError }
    > => {
      try {
        await authorize(client);
      } catch (reason) {
        if (reason instanceof AuthorizationDeniedError) {
          // Commit the policy audit, but never execute business work.
          // Return the denial only after an acknowledged COMMIT.
          return { allowed: false, reason };
        }
        throw reason;
      }
      return { allowed: true, value: await work(client) };
    },
  );
  if (!outcome.allowed) throw outcome.reason;
  return outcome.value;
}

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
  return runProtectedTransaction(
    pool,
    (client) =>
      requireTenantPermission(
        client,
        actor,
        { kind: "organization", tenantId: actor.tenantId },
        permission,
      ),
    work,
  );
}
