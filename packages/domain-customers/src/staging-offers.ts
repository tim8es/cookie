import type { PoolClient, QueryResultRow } from "pg";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";
import { CUSTOMER_OFFERS_PERMISSION, readStagingCustomerContext } from "./staging-customer.js";
import { previewStagingAvailability, type AvailabilitySelection } from "../../domain-scheduling/src/staging-availability.js";

interface OfferRow extends QueryResultRow {
  location_id:string; location_name:string; staff_id:string; staff_name:string;
  service_id:string; service_name:string; time_zone:string; duration_minutes:number; price_kopecks:string;
}

/** Exact session-bound customer and distinct read capability; never owner AuthZ. */
async function requireCustomerOffers(client:PoolClient, actor:TrustedActor):Promise<void> {
  await readStagingCustomerContext(client,actor);
  await requireTenantPermission(client,actor,{kind:"customer-self",tenantId:actor.tenantId,clientIdentityId:actor.identityId},CUSTOMER_OFFERS_PERMISSION);
}

/** Only active, grant-bound placements. No Customer/Booking IDs, contacts, role
 * data or raw schedule intervals leave this projection. Price is base-only.
 */
export async function listStagingCustomerOffers(client:PoolClient,actor:TrustedActor) {
  await requireCustomerOffers(client,actor);
  const result=await client.query<OfferRow>(
    `SELECT DISTINCT l.id::text AS location_id,l.display_name AS location_name,
       st.id::text AS staff_id,st.display_name AS staff_name,
       s.id::text AS service_id,s.display_name AS service_name,
       l.time_zone,s.duration_minutes,s.base_price_kopecks::text AS price_kopecks
       FROM cookie_entitlement.staging_publication_grants g
       JOIN cookie_staff.staging_publication_receipts p ON p.tenant_id=g.tenant_id AND p.grant_id=g.id
       JOIN cookie_staff.staff_profiles st ON st.tenant_id=p.tenant_id AND st.id=p.staff_id
       JOIN cookie_staff.location_assignments la ON la.tenant_id=p.tenant_id AND la.staff_id=p.staff_id AND la.location_id=p.location_id
       JOIN cookie_staff.service_assignments sa ON sa.tenant_id=p.tenant_id AND sa.staff_id=p.staff_id AND sa.location_id=p.location_id AND sa.service_id=p.service_id
       JOIN cookie_catalog.services s ON s.tenant_id=sa.tenant_id AND s.id=sa.service_id
       JOIN cookie_tenancy.locations l ON l.tenant_id=la.tenant_id AND l.id=la.location_id
       WHERE p.tenant_id=$1::uuid AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
         AND st.active AND st.bookable AND la.active AND sa.active AND s.active AND l.time_zone IS NOT NULL
       ORDER BY location_name,service_name,staff_name,location_id,service_id,staff_id LIMIT 201`,
    [actor.tenantId]);
  if(result.rows.length>200)throw new Error("Offers overflow");
  return {offers:result.rows.map(row=>({
    locationId:row.location_id,locationName:row.location_name,staffId:row.staff_id,staffName:row.staff_name,
    serviceId:row.service_id,serviceName:row.service_name,timeZone:row.time_zone,
    durationMinutes:row.duration_minutes,basePriceKopecks:row.price_kopecks,
  }))};
}

export async function listStagingCustomerSlots(client:PoolClient,actor:TrustedActor,selection:AvailabilitySelection) {
  await requireCustomerOffers(client,actor);
  const result=await previewStagingAvailability(client,actor.tenantId,selection);
  // Buffer/occupancy internals are not needed by a customer.
  return {localDate:result.localDate,timeZone:result.timeZone,
    slots:result.slots.map(slot=>({startAt:slot.startAt,endAt:slot.endAt}))};
}
