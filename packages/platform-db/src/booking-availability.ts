import type { PoolClient, QueryResultRow } from "pg";

import {
  listAvailableSlots,
  type AvailableSlot,
} from "../../domain-scheduling/src/index.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";

/**
 * Tenant-scoped F1 read port for availability and provisional base price.
 * The caller owns the SQL transaction (authorization audit is a write).
 * A read is never a hold; CreateBooking independently rechecks inside COMMIT.
 */
export interface AvailabilityReadInput {
  readonly actor: TrustedActor;
  readonly locationId: string;
  readonly staffId: string;
  readonly serviceId: string;
  readonly localDate: string;
}

export interface AvailabilitySnapshot {
  readonly slots: readonly AvailableSlot[];
  readonly priceKopecks: string;
  readonly durationMinutes: number;
  readonly postServiceBufferMinutes: number;
  readonly timeZone: string;
}

interface ServiceRow extends QueryResultRow {
  readonly duration_minutes: number;
  readonly post_service_buffer_minutes: number;
  readonly base_price_kopecks: string;
  readonly time_zone: string;
}
interface WindowRow extends QueryResultRow {
  readonly start_at: Date;
  readonly end_at: Date;
}
interface BlockRow extends WindowRow {
  readonly kind: "break" | "exception";
}
interface OccupiedRow extends QueryResultRow {
  readonly location_id: string;
  readonly start_at: Date;
  readonly occupied_until: Date;
}

function intervals(rows: readonly WindowRow[]) {
  return rows.map((row) => ({
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
  }));
}

export async function readBookingAvailability(
  client: PoolClient,
  input: AvailabilityReadInput,
): Promise<AvailabilitySnapshot | null> {
  const { actor, locationId, staffId, serviceId, localDate } = input;
  await requireTenantPermission(
    client,
    actor,
    {
      kind: "booking",
      tenantId: actor.tenantId,
      locationId,
      staffProfileId: staffId,
    },
    "booking.create",
  );

  const service = await client.query<ServiceRow>(
    `SELECT service.duration_minutes, service.post_service_buffer_minutes,
            service.base_price_kopecks::text, loc.time_zone
       FROM cookie_staff.service_assignments assignment
       JOIN cookie_staff.location_assignments staff_loc
         ON staff_loc.tenant_id=assignment.tenant_id
        AND staff_loc.location_id=assignment.location_id
        AND staff_loc.staff_id=assignment.staff_id
       JOIN cookie_staff.staff_profiles staff
         ON staff.tenant_id=assignment.tenant_id AND staff.id=assignment.staff_id
       JOIN cookie_catalog.services service
         ON service.tenant_id=assignment.tenant_id AND service.id=assignment.service_id
       JOIN cookie_tenancy.locations loc
         ON loc.tenant_id=assignment.tenant_id AND loc.id=assignment.location_id
      WHERE assignment.tenant_id=$1::uuid AND assignment.location_id=$2::uuid
        AND assignment.staff_id=$3::uuid AND assignment.service_id=$4::uuid
        AND assignment.active AND staff_loc.active AND staff.active
        AND staff.bookable AND service.active AND loc.time_zone IS NOT NULL`,
    [actor.tenantId, locationId, staffId, serviceId],
  );
  const settings = service.rows[0];
  if (!settings) return null;

  const shifts = await client.query<WindowRow>(
    `SELECT start_at, end_at FROM cookie_scheduling.shift_windows
       WHERE tenant_id=$1::uuid AND location_id=$2::uuid
         AND staff_id=$3::uuid AND active`,
    [actor.tenantId, locationId, staffId],
  );
  const blocked = await client.query<BlockRow>(
    `SELECT start_at, end_at, kind FROM cookie_scheduling.blocked_windows
       WHERE tenant_id=$1::uuid AND location_id=$2::uuid
         AND staff_id=$3::uuid AND active`,
    [actor.tenantId, locationId, staffId],
  );
  const occupied = await client.query<OccupiedRow>(
    `SELECT location_id::text, start_at, occupied_until
       FROM cookie_booking.bookings
      WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
        AND status='Confirmed'`,
    [actor.tenantId, staffId],
  );

  const available = listAvailableSlots({
    organizationId: actor.tenantId,
    locationId,
    staffId,
    localDate,
    timeZone: settings.time_zone,
    serviceDurationMinutes: settings.duration_minutes,
    postServiceBufferMinutes: settings.post_service_buffer_minutes,
    stepMinutes: 1,
    shifts: intervals(shifts.rows),
    breaks: intervals(blocked.rows.filter((row) => row.kind === "break")),
    exceptions: intervals(
      blocked.rows.filter((row) => row.kind === "exception"),
    ),
    occupied: occupied.rows.map((row) => ({
      organizationId: actor.tenantId,
      locationId: row.location_id,
      staffId,
      startAt: row.start_at.toISOString(),
      occupiedUntil: row.occupied_until.toISOString(),
    })),
  });

  // The database read is only a snapshot. Never promise the slot is held.
  return {
    slots: available.filter((slot) => Date.parse(slot.startAt) > Date.now()),
    priceKopecks: settings.base_price_kopecks,
    durationMinutes: settings.duration_minutes,
    postServiceBufferMinutes: settings.post_service_buffer_minutes,
    timeZone: settings.time_zone,
  };
}
