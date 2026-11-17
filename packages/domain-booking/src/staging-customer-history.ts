import type { PoolClient, QueryResultRow } from "pg";

import { readStagingCustomerContext } from "../../domain-customers/src/index.js";
import {
  AuthorizationDeniedError,
  requireTenantPermission,
  type TrustedActor,
} from "../../platform-identity/src/index.js";

interface BookingRow extends QueryResultRow {
  booking_id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  price_kopecks: string;
  location_name: string;
  service_name: string;
  staff_name: string;
  time_zone: string | null;
}

/** Only the exact bearer-bound Customer; neither request IDs nor an active
 * publication grant can substitute for current client authorization.
 * History remains readable after grant expiry. Names are current catalog
 * labels; time and price come from the persisted booking, not the catalog.
 */
export async function listOwnStagingBookings(
  client: PoolClient,
  actor: TrustedActor,
) {
  const context = await readStagingCustomerContext(client, actor);
  await requireTenantPermission(
    client,
    actor,
    {
      kind: "customer-self",
      tenantId: actor.tenantId,
      clientIdentityId: actor.identityId,
    },
    "staging.customer.bookings.read",
  );
  const result = await client.query<BookingRow>(
    `SELECT b.id::text AS booking_id,b.status,b.start_at,b.end_at,
            b.price_kopecks_snapshot::text AS price_kopecks,
            l.display_name AS location_name,l.time_zone,
            s.display_name AS service_name,p.display_name AS staff_name
       FROM cookie_booking.bookings b
       JOIN cookie_tenancy.locations l ON l.tenant_id=b.tenant_id AND l.id=b.location_id
       JOIN cookie_catalog.services s ON s.tenant_id=b.tenant_id AND s.id=b.service_id
       JOIN cookie_staff.staff_profiles p ON p.tenant_id=b.tenant_id AND p.id=b.staff_id
      WHERE b.tenant_id=$1::uuid AND b.customer_id=$2::uuid
      ORDER BY b.start_at DESC,b.id DESC LIMIT 201`,
    [context.tenantId, context.customerId],
  );
  const current = await readStagingCustomerContext(client, actor);
  if (current.customerId !== context.customerId) {
    throw new AuthorizationDeniedError();
  }
  return {
    bookings: result.rows.slice(0, 200).map((row) => ({
      bookingId: row.booking_id,
      status: row.status,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at.toISOString(),
      priceKopecks: row.price_kopecks,
      locationName: row.location_name,
      serviceName: row.service_name,
      staffName: row.staff_name,
      timeZone: row.time_zone,
    })),
    hasMore: result.rows.length > 200,
  };
}
