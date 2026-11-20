import type { PoolClient, QueryResultRow } from "pg";

import { resolveLocalMinute } from "../../domain-scheduling/src/index.js";

/** Calendar is an application read adapter, not a booking command or availability. */
export const CALENDAR_STATUSES = [
  "Confirmed",
  "CancelledByClient",
  "CancelledByBusiness",
  "Completed",
  "NoShow",
] as const;
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

export interface CalendarRange {
  readonly locationId: string;
  readonly localDate: string;
  readonly days: 1 | 7;
}

export class CalendarRangeError extends Error {}
export class CalendarBranchUnavailable extends Error {}
export class CalendarOverflow extends Error {}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const ms = Date.parse(value + "T00:00:00Z");
  return (
    Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 10) === value &&
    value >= "2000-01-01" &&
    value <= "2099-12-24"
  );
}

interface LocationRow extends QueryResultRow {
  time_zone: string | null;
}
interface CalendarRow extends QueryResultRow {
  id: string;
  status: CalendarStatus;
  start_at: Date;
  end_at: Date;
  staff_name: string;
  service_name: string;
  price: string;
}

export interface CalendarEntry {
  readonly id: string;
  readonly status: CalendarStatus;
  readonly startAt: string;
  readonly endAt: string;
  readonly staffName: string;
  readonly serviceName: string;
  readonly priceKopecks: string;
}

export interface OwnerCalendar {
  readonly locationId: string;
  readonly localDate: string;
  readonly days: 1 | 7;
  readonly timeZone: string;
  readonly entries: readonly CalendarEntry[];
}

/** Caller holds the current tenant policy transaction. No customer IDs or PII. */
export async function readOwnerCalendar(
  client: PoolClient,
  tenantId: string,
  input: CalendarRange,
): Promise<OwnerCalendar> {
  if (!isCalendarDate(input.localDate) || ![1, 7].includes(input.days))
    throw new CalendarRangeError();
  const branch = await client.query<LocationRow>(
    `SELECT time_zone FROM cookie_tenancy.locations
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`,
    [tenantId, input.locationId],
  );
  const timeZone = branch.rows[0]?.time_zone;
  if (!timeZone) throw new CalendarBranchUnavailable();

  let from: string;
  let to: string;
  try {
    const endDate = new Date(
      Date.parse(input.localDate + "T00:00:00Z") + input.days * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    from = resolveLocalMinute(input.localDate + "T00:00", timeZone);
    to = resolveLocalMinute(endDate + "T00:00", timeZone);
  } catch {
    // A nonexistent or ambiguous local midnight must not silently shift the day.
    throw new CalendarRangeError();
  }
  const result = await client.query<CalendarRow>(
    `SELECT b.id::text,b.status,b.start_at,b.end_at,
            p.display_name AS staff_name,s.display_name AS service_name,
            b.price_kopecks_snapshot::text AS price
       FROM cookie_booking.bookings b
       JOIN cookie_staff.staff_profiles p
         ON p.tenant_id=b.tenant_id AND p.id=b.staff_id
       JOIN cookie_catalog.services s
         ON s.tenant_id=b.tenant_id AND s.id=b.service_id
      WHERE b.tenant_id=$1::uuid AND b.location_id=$2::uuid
        AND b.start_at >= $3::timestamptz - interval '24 hours'
        AND b.start_at < $4::timestamptz AND b.end_at > $3::timestamptz
      ORDER BY b.start_at,b.id LIMIT 501`,
    [tenantId, input.locationId, from, to],
  );
  // Never return a misleading partial calendar. Narrow the period or branch.
  if (result.rows.length > 500) throw new CalendarOverflow();
  return {
    ...input,
    timeZone,
    entries: result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at.toISOString(),
      staffName: row.staff_name,
      serviceName: row.service_name,
      priceKopecks: row.price,
    })),
  };
}

export interface OwnerBookingDetail extends CalendarEntry {
  readonly locationId: string;
  readonly timeZone: string;
  readonly durationMinutes: number;
  readonly bufferMinutes: number;
  readonly occupiedUntil: string;
  readonly cancelledAt: string | null;
}

interface DetailRow extends CalendarRow {
  location_id: string;
  time_zone: string;
  duration_minutes: number;
  buffer_minutes: number;
  occupied_until: Date;
  cancelled_at: Date | null;
}

/** Exact tenant and branch lookup under the caller's current owner policy.
 * Return only the persisted Booking snapshot and current display labels.
 */
export async function readOwnerBookingDetail(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  bookingId: string,
): Promise<OwnerBookingDetail | null> {
  const result = await client.query<DetailRow>(
    `SELECT b.id::text,b.status,b.start_at,b.end_at,b.occupied_until,
            b.cancelled_at,b.location_id::text,l.time_zone,
            b.service_duration_minutes_snapshot AS duration_minutes,
            b.post_service_buffer_minutes_snapshot AS buffer_minutes,
            p.display_name AS staff_name,s.display_name AS service_name,
            b.price_kopecks_snapshot::text AS price
       FROM cookie_booking.bookings b
       JOIN cookie_tenancy.locations l
         ON l.tenant_id=b.tenant_id AND l.id=b.location_id
       JOIN cookie_staff.staff_profiles p
         ON p.tenant_id=b.tenant_id AND p.id=b.staff_id
       JOIN cookie_catalog.services s
         ON s.tenant_id=b.tenant_id AND s.id=b.service_id
      WHERE b.tenant_id=$1::uuid AND b.location_id=$2::uuid AND b.id=$3::uuid
        AND l.time_zone IS NOT NULL
      FOR SHARE OF l`,
    [tenantId, locationId, bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    locationId: row.location_id,
    timeZone: row.time_zone,
    status: row.status,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    occupiedUntil: row.occupied_until.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    durationMinutes: row.duration_minutes,
    bufferMinutes: row.buffer_minutes,
    staffName: row.staff_name,
    serviceName: row.service_name,
    priceKopecks: row.price,
  };
}
