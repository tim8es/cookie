import type { PoolClient, QueryResultRow } from "pg";
import { requireTenantPermission, type TrustedActor } from "../../platform-identity/src/index.js";
import { CUSTOMER_APPOINTMENTS_PERMISSION, readStagingCustomerContext } from "./staging-customer.js";

type Status = "Confirmed" | "CancelledByClient" | "CancelledByBusiness" | "Completed" | "NoShow";

interface AppointmentRow extends QueryResultRow {
  id: string;
  status: Status;
  start_at: Date;
  end_at: Date;
  location_name: string;
  staff_name: string;
  service_name: string;
  time_zone: string | null;
  price: string;
}

/** A client may read only the Customer resolved from the exact active session.
 * Existing commitments remain readable independently of new-booking entitlement.
 * The price is the immutable booking snapshot; display names are current labels.
 */
export async function listStagingCustomerAppointments(client: PoolClient, actor: TrustedActor) {
  const context = await readStagingCustomerContext(client, actor);
  await requireTenantPermission(client, actor, {kind:"customer-self",tenantId:actor.tenantId,clientIdentityId:actor.identityId}, CUSTOMER_APPOINTMENTS_PERMISSION);
  const result = await client.query<AppointmentRow>(
    `SELECT b.id::text,b.status,b.start_at,b.end_at,
         loc.display_name AS location_name,staff.display_name AS staff_name,
         service.display_name AS service_name,loc.time_zone,b.price_kopecks_snapshot::text AS price
       FROM cookie_booking.bookings b
       JOIN cookie_tenancy.locations loc ON loc.tenant_id=b.tenant_id AND loc.id=b.location_id
       JOIN cookie_staff.staff_profiles staff ON staff.tenant_id=b.tenant_id AND staff.id=b.staff_id
       JOIN cookie_catalog.services service ON service.tenant_id=b.tenant_id AND service.id=b.service_id
       WHERE b.tenant_id=$1::uuid AND b.customer_id=$2::uuid
       ORDER BY b.start_at DESC,b.id LIMIT 201`,
    [actor.tenantId,context.customerId],
  );
  if (result.rows.some(row=>!row.time_zone)) throw new Error("Appointment branch zone unavailable");
  return {
    appointments: result.rows.slice(0,200).map(row=>({
      bookingId:row.id,status:row.status,startAt:row.start_at.toISOString(),endAt:row.end_at.toISOString(),
      locationName:row.location_name,staffName:row.staff_name,serviceName:row.service_name,timeZone:row.time_zone!,
      priceKopecks:row.price,
    })),
    hasMore: result.rows.length>200,
  };
}
