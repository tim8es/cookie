import type { PoolClient } from "pg";

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

type IdentityEvent =
  | "email_registered"
  | "email_login"
  | "email_provider_linked"
  | "password_recovered"
  | "telegram_registered"
  | "telegram_login"
  | "telegram_provider_linked"
  | "owner_workspace_created"
  | "customer_enrolled";

/** Must use the same transaction as the successful identity change. */
export async function appendAuthIdentityAudit(
  client: PoolClient,
  event: IdentityEvent,
  identityId: string,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO cookie_identity.auth_security_events(event_type,identity_id)
     VALUES ($1,$2::uuid)`,
    [event, identityId],
  );
  if (result.rowCount !== 1) throw new Error("Auth security audit failed");
}

/** Operator-only maintenance. Retention must be configured and approved. */
export async function purgeAuthSecurityEvents(
  transaction: Transaction,
  batchSize: number,
  retentionSeconds: number,
): Promise<number> {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    !Number.isSafeInteger(retentionSeconds) ||
    retentionSeconds < 60 ||
    retentionSeconds > 31536000
  ) {
    throw new Error("Invalid auth audit retention configuration");
  }
  return transaction(async (client) => {
    const result = await client.query(
      `WITH expired AS (
         SELECT id FROM cookie_identity.auth_security_events
         WHERE occurred_at<=statement_timestamp()-$2::integer*interval '1 second'
         ORDER BY occurred_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM cookie_identity.auth_security_events AS event
       USING expired WHERE event.id=expired.id`,
      [batchSize, retentionSeconds],
    );
    if (result.rowCount === null) throw new Error("Auth audit purge failed");
    return result.rowCount;
  });
}
