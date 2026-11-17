import type { Pool, PoolClient } from "pg";

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
  const client = await pool.connect();
  let state: "starting" | "open" | "committing" | "finished" = "starting";
  let discard = false;

  async function commit(): Promise<void> {
    const result = await client.query("COMMIT");
    if (result.command !== "COMMIT") {
      throw new Error("Protected transaction did not commit");
    }
  }

  try {
    await client.query("BEGIN");
    state = "open";
    try {
      await authorize(client);
    } catch (reason) {
      if (reason instanceof AuthorizationDeniedError) {
        // The policy writes a sanitized denial audit. Commit ONLY before
        // executing business work. A failed audit commit is unavailable.
        state = "committing";
        await commit();
        state = "finished";
      }
      throw reason;
    }
    const result = await work(client);
    state = "committing";
    await commit();
    state = "finished";
    return result;
  } catch (reason) {
    if (state === "open") {
      try {
        const rolledBack = await client.query("ROLLBACK");
        if (rolledBack.command !== "ROLLBACK") {
          throw new Error("Protected transaction did not roll back");
        }
        state = "finished";
      } catch {
        discard = true;
        throw new Error("Protected transaction cleanup failed");
      }
    } else if (state !== "finished") {
      // BEGIN or COMMIT failed: the server-side state/outcome is uncertain.
      // Do not retry the write or reuse its connection.
      discard = true;
    }
    throw reason;
  } finally {
    client.release(discard);
  }
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
