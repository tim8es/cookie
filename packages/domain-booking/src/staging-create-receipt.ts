import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

import { readStagingCustomerContext } from "../../domain-customers/src/index.js";
import {
  AuthorizationDeniedError,
  requireTenantPermission,
  type TrustedActor,
} from "../../platform-identity/src/index.js";
import type { ConfirmedBookingReceipt } from "./create.js";

interface ReceiptRow extends QueryResultRow {
  result: ConfirmedBookingReceipt;
}

/** Positive-only recovery of an original committed Create operation.
 * Absence is never evidence that an in-flight mutation failed.
 * The exact bearer-bound Customer and current permission are mandatory.
 */
export async function readStagingCreateReceipt(
  client: PoolClient,
  actor: TrustedActor,
  key: string,
): Promise<ConfirmedBookingReceipt | null> {
  const context = await readStagingCustomerContext(client, actor);
  await requireTenantPermission(
    client,
    actor,
    {
      kind: "customer-self",
      tenantId: actor.tenantId,
      clientIdentityId: actor.identityId,
    },
    "staging.customer.booking.create",
  );
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  const result = await client.query<ReceiptRow>(
    `SELECT r.result
       FROM cookie_booking.command_receipts r
       JOIN cookie_booking.bookings b
         ON b.tenant_id=r.tenant_id AND b.id=r.booking_id
      WHERE r.tenant_id=$1::uuid AND r.actor_identity_id=$2::uuid
        AND r.operation='booking.create' AND r.key_sha256=$3
        AND b.customer_id=$4::uuid
        AND r.result->>'bookingId'=b.id::text
        AND r.result->>'status'='Confirmed'`,
    [actor.tenantId, actor.identityId, digest, context.customerId],
  );
  const current = await readStagingCustomerContext(client, actor);
  if (current.customerId !== context.customerId) {
    throw new AuthorizationDeniedError();
  }
  return result.rows[0]?.result ?? null;
}
