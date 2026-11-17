import type { PoolClient, QueryResultRow } from "pg";
import { listAvailableSlots, type AvailableSlot } from "./index.js";
import { validateLocalMinute } from "./local-minute.js";

export interface AvailabilitySelection {
  readonly staffId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly localDate: string;
}
export class PreviewUnavailable extends Error {}
interface Window { start: string; end: string; kind?: "break" | "exception"; locationId?: string }
interface AvailabilityRow extends QueryResultRow {
  time_zone: string;
  duration_minutes: number;
  post_service_buffer_minutes: number;
  now_at: Date;
  shifts: Window[];
  blocks: Window[];
  busy: Window[];
}

/** One authoritative read snapshot, limited to the selected date's possible
 * UTC interval plus the maximum service+buffer. Never authorizes a booking.
 * Retain original intervals (not clipped) to preserve shift grid semantics.
 */
export async function previewStagingAvailability(
  client: PoolClient, tenantId: string, input: AvailabilitySelection,
): Promise<{ localDate: string; timeZone: string; slots: AvailableSlot[] }> {
  validateLocalMinute(input.localDate+"T00:00");
  const result = await client.query<AvailabilityRow>(
    `WITH bounds AS (
        SELECT ($5::date::timestamp AT TIME ZONE 'UTC')-interval '1 day' AS lo,
               ($5::date::timestamp AT TIME ZONE 'UTC')+interval '4 days' AS hi
      )
      SELECT l.time_zone,s.duration_minutes,s.post_service_buffer_minutes,clock_timestamp() AS now_at,
        COALESCE((SELECT jsonb_agg(to_jsonb(w)) FROM (
          SELECT start_at AS start,end_at AS "end" FROM cookie_scheduling.shift_windows
           WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid AND active
             AND start_at<bounds.hi AND end_at>bounds.lo LIMIT 201
        ) w),'[]'::jsonb) AS shifts,
        COALESCE((SELECT jsonb_agg(to_jsonb(w)) FROM (
          SELECT start_at AS start,end_at AS "end",kind FROM cookie_scheduling.blocked_windows
           WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid AND active
             AND start_at<bounds.hi AND end_at>bounds.lo LIMIT 201
        ) w),'[]'::jsonb) AS blocks,
        COALESCE((SELECT jsonb_agg(to_jsonb(w)) FROM (
          SELECT start_at AS start,occupied_until AS "end",location_id::text AS "locationId" FROM cookie_booking.bookings
           WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND status='Confirmed'
             AND start_at<bounds.hi AND occupied_until>bounds.lo LIMIT 201
        ) w),'[]'::jsonb) AS busy
       FROM cookie_entitlement.staging_publication_grants g
       JOIN cookie_staff.staging_publication_receipts p ON p.tenant_id=g.tenant_id AND p.grant_id=g.id
       JOIN cookie_staff.staff_profiles st ON st.tenant_id=p.tenant_id AND st.id=p.staff_id
       JOIN cookie_staff.location_assignments la ON la.tenant_id=p.tenant_id AND la.staff_id=p.staff_id AND la.location_id=p.location_id
       JOIN cookie_staff.service_assignments sa ON sa.tenant_id=p.tenant_id AND sa.staff_id=p.staff_id AND sa.location_id=p.location_id AND sa.service_id=p.service_id
       JOIN cookie_catalog.services s ON s.tenant_id=sa.tenant_id AND s.id=sa.service_id
       JOIN cookie_tenancy.locations l ON l.tenant_id=la.tenant_id AND l.id=la.location_id
       CROSS JOIN bounds
       WHERE p.tenant_id=$1::uuid AND p.staff_id=$2::uuid AND p.location_id=$3::uuid AND p.service_id=$4::uuid
         AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
         AND st.active AND st.bookable AND la.active AND sa.active AND s.active AND l.time_zone IS NOT NULL
       LIMIT 1`,
    [tenantId,input.staffId,input.locationId,input.serviceId,input.localDate]);
  const row=result.rows[0];
  if (!row) throw new PreviewUnavailable();
  if ([row.shifts,row.blocks,row.busy].some(list=>list.length>200)) throw new Error("Preview window overflow");
  const interval=(w: Window)=>({startAt:new Date(w.start).toISOString(),endAt:new Date(w.end).toISOString()});
  // 15-minute display grid is a staging preview choice, not a final booking rule.
  const slots=listAvailableSlots({
    organizationId:tenantId,staffId:input.staffId,locationId:input.locationId,
    localDate:input.localDate,timeZone:row.time_zone,
    serviceDurationMinutes:row.duration_minutes,postServiceBufferMinutes:row.post_service_buffer_minutes,
    stepMinutes:15,
    shifts:row.shifts.map(interval),
    breaks:row.blocks.filter(w=>w.kind==="break").map(interval),
    exceptions:row.blocks.filter(w=>w.kind==="exception").map(interval),
    occupied:row.busy.map(w=>({organizationId:tenantId,staffId:input.staffId,locationId:w.locationId!,startAt:new Date(w.start).toISOString(),occupiedUntil:new Date(w.end).toISOString()})),
  }).filter(slot=>Date.parse(slot.startAt)>row.now_at.getTime());
  return {localDate:input.localDate,timeZone:row.time_zone,slots};
}
