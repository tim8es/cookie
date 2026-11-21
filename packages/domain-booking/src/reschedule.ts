import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  evaluateAvailableStart,
  lockActiveShiftWindows,
  lockActiveBlockedWindows,
  type StaffOccupancy,
} from "../../domain-scheduling/src/index.js";
import {
  enqueueOutbox,
  runSqlTransaction,
} from "../../platform-db/src/index.js";
import type { TrustedActor } from "../../platform-identity/src/index.js";
import { requireTenantPermission, AuthorizationDeniedError } from "../../platform-identity/src/index.js";
import { readStagingCustomerContext } from "../../domain-customers/src/index.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

export type RescheduleBookingFailureCode =
  | "INVALID_RESCHEDULE_COMMAND"
  | "BOOKING_NOT_FOUND"
  | "BOOKING_NOT_CONFIRMED"
  | "RESCHEDULE_NOT_AVAILABLE"
  | "RESCHEDULE_CONFLICT"
  | "RESCHEDULE_POLICY_DENIED"
  | "IDEMPOTENCY_KEY_REUSED";

export class RescheduleBookingFailure extends Error {
  constructor(readonly code: RescheduleBookingFailureCode) {
    super(code);
    this.name = "RescheduleBookingFailure";
  }
}

export interface InternalRescheduleBooking {
  /** A server-verified actor; client JSON must never construct this claim. */
  readonly actor: TrustedActor;
  readonly bookingId: string;
  readonly idempotencyKey: string;
  /** Absolute UTC minute. Never accept ambiguous local wall-clock time. */
  readonly newStartAt: string;
}

export interface RescheduledBookingReceipt {
  readonly bookingId: string;
  readonly status: "Confirmed";
  readonly previousStartAt: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly occupiedUntil: string;
  /** Monetary snapshot from original CreateBooking, never current Catalog. */
  readonly priceKopecks: string;
}

/** Mandatory trusted business deadline/exception/entitlement policy adapter. */
export type AssertBookingMayReschedule = (
  client: PoolClient,
  context: {
    readonly tenantId: string;
    readonly bookingId: string;
    readonly staffId: string;
    readonly locationId: string;
    readonly serviceId: string;
    readonly customerId: string;
    readonly oldStartAt: string;
    readonly oldEndAt: string;
    readonly newStartAt: string;
  },
) => Promise<void>;

interface BookingRow extends QueryResultRow {
  id: string;
  customer_id: string;
  staff_id: string;
  location_id: string;
  service_id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  service_duration_minutes_snapshot: number;
  post_service_buffer_minutes_snapshot: number;
  price_kopecks_snapshot: string;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  result: RescheduledBookingReceipt;
}
interface OccupiedRow extends QueryResultRow {
  location_id: string;
  start_at: Date;
  occupied_until: Date;
}

function fail(code: RescheduleBookingFailureCode): never {
  throw new RescheduleBookingFailure(code);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validate(input: InternalRescheduleBooking): string {
  if (
    !input ||
    !input.actor ||
    !UUID.test(input.actor.tenantId) ||
    !UUID.test(input.actor.identityId) ||
    typeof input.actor.correlationId !== "string" ||
    input.actor.correlationId.length < 1 ||
    input.actor.correlationId.length > 128 ||
    !UUID.test(input.bookingId) ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128 ||
    typeof input.newStartAt !== "string" ||
    !UTC_MINUTE.test(input.newStartAt)
  ) {
    return fail("INVALID_RESCHEDULE_COMMAND");
  }
  const timestamp = Date.parse(input.newStartAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 19) !==
      input.newStartAt.slice(0, 19)
  ) {
    return fail("INVALID_RESCHEDULE_COMMAND");
  }
  return new Date(timestamp).toISOString();
}

function localDateAt(utc: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(utc));
  const value = (kind: string): string =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

async function readAvailableSlot(
  client: PoolClient,
  tenantId: string,
  booking: BookingRow,
  newStartAt: string,
): Promise<{ startAt: string; endAt: string; occupiedUntil: string }> {
  const currentTime = await client.query<{ now: Date }>(
    "SELECT clock_timestamp() AS now",
  );
  if (
    Date.parse(newStartAt) <=
    (currentTime.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY)
  ) {
    fail("RESCHEDULE_NOT_AVAILABLE");
  }
  // The old booking's snapshot supplies duration + buffer; a catalog edit
  // cannot silently change the visit or its monetary/promo snapshot.
  const reference = await client.query<{ time_zone: string | null }>(
    `SELECT loc.time_zone
       FROM cookie_staff.service_assignments AS assignment
       JOIN cookie_staff.location_assignments AS staff_loc
         ON staff_loc.tenant_id=assignment.tenant_id
        AND staff_loc.staff_id=assignment.staff_id
        AND staff_loc.location_id=assignment.location_id
       JOIN cookie_staff.staff_profiles AS staff
         ON staff.tenant_id=assignment.tenant_id
        AND staff.id=assignment.staff_id
       JOIN cookie_catalog.services AS service
         ON service.tenant_id=assignment.tenant_id
        AND service.id=assignment.service_id
       JOIN cookie_tenancy.locations AS loc
         ON loc.tenant_id=assignment.tenant_id
        AND loc.id=assignment.location_id
      WHERE assignment.tenant_id=$1::uuid AND assignment.location_id=$2::uuid
        AND assignment.staff_id=$3::uuid AND assignment.service_id=$4::uuid
        AND assignment.active AND staff_loc.active AND staff.active
        AND staff.bookable AND service.active
      FOR SHARE OF assignment, staff_loc, staff, service, loc`,
    [tenantId, booking.location_id, booking.staff_id, booking.service_id],
  );
  const zone = reference.rows[0]?.time_zone;
  if (!zone) fail("RESCHEDULE_NOT_AVAILABLE");

  const scope = {
    tenantId,
    staffId: booking.staff_id,
    locationId: booking.location_id,
  };
  const shifts = await lockActiveShiftWindows(client, scope);
  const blocked = await lockActiveBlockedWindows(client, scope);
  const occupiedRows = await client.query<OccupiedRow>(
    `SELECT location_id::text, start_at, occupied_until
       FROM cookie_booking.bookings
      WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
        AND status='Confirmed' AND id <> $3::uuid`,
    [tenantId, booking.staff_id, booking.id],
  );
  const occupied: StaffOccupancy[] = occupiedRows.rows.map((row) => ({
    organizationId: tenantId,
    staffId: booking.staff_id,
    locationId: row.location_id,
    startAt: row.start_at.toISOString(),
    occupiedUntil: row.occupied_until.toISOString(),
  }));
  const slot = evaluateAvailableStart(
    {
      organizationId: tenantId,
      staffId: booking.staff_id,
      locationId: booking.location_id,
      localDate: localDateAt(newStartAt, zone),
      timeZone: zone,
      serviceDurationMinutes: booking.service_duration_minutes_snapshot,
      postServiceBufferMinutes: booking.post_service_buffer_minutes_snapshot,
      stepMinutes: 1,
      shifts,
      breaks: blocked.filter((row) => row.kind === "break"),
      exceptions: blocked.filter((row) => row.kind === "exception"),
      occupied,
    },
    newStartAt,
  );
  return slot ?? fail("RESCHEDULE_NOT_AVAILABLE");
}

/**
 * F1 INTERNAL time-only reschedule. No caller exposes this command to clients
 * until verified AuthN, Customer ownership and a real deadline policy exist.
 * Staff lock → booking lock serializes with CancelBooking/CreateBooking.
 * The GiST exclusion is the final concurrent double-booking safeguard.
 */
export async function rescheduleBookingInternal(
  pool: Pool,
  input: InternalRescheduleBooking,
  assertMayReschedule: AssertBookingMayReschedule,
): Promise<RescheduledBookingReceipt> {
  if (typeof assertMayReschedule !== "function") fail("INVALID_RESCHEDULE_COMMAND");
  return rescheduleBooking(pool, input, assertMayReschedule);
}

/** Controlled staging only; never use a default or cancel cutoff as policy. */
export async function rescheduleStagingCustomerBooking(
  pool: Pool,
  input: InternalRescheduleBooking,
  cutoffMinutes: number,
): Promise<RescheduledBookingReceipt> {
  if (!Number.isSafeInteger(cutoffMinutes) || cutoffMinutes < 0 || cutoffMinutes > 525600)
    fail("INVALID_RESCHEDULE_COMMAND");
  if (!input?.actor?.opaqueSessionAuthority) throw new AuthorizationDeniedError();
  return rescheduleBooking(pool, input, async (client, context) => {
    const allowed = await client.query(
      "SELECT 1 WHERE $1::timestamptz > clock_timestamp() + $2::int * interval '1 minute' AND $3::timestamptz > clock_timestamp() + $2::int * interval '1 minute'",
      [context.oldStartAt, cutoffMinutes, context.newStartAt],
    );
    if (allowed.rowCount !== 1) fail("RESCHEDULE_POLICY_DENIED");
  }, cutoffMinutes);
}

async function rescheduleBooking(
  pool: Pool,
  input: InternalRescheduleBooking,
  assertMayReschedule: AssertBookingMayReschedule,
  cutoffMinutes?: number,
): Promise<RescheduledBookingReceipt> {
  const staging = cutoffMinutes !== undefined;
  const newStartAt = validate(input);
  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = hash(input.idempotencyKey);
  const requestHash = hash(JSON.stringify(staging ? [input.bookingId, newStartAt, "staging.client"] : [input.bookingId, newStartAt]));
  try {
    return await runSqlTransaction(pool, async (client) => {
      // The actor never chooses staff/location via request parameters.
      const initial = await client.query<{
        staff_id: string;
        location_id: string;
      }>(
        `SELECT staff_id::text, location_id::text FROM cookie_booking.bookings
          WHERE tenant_id=$1::uuid AND id=$2::uuid
            AND (NOT $3::boolean OR EXISTS (
              SELECT 1 FROM cookie_customers.staging_customer_identities c
               WHERE c.tenant_id=bookings.tenant_id AND c.customer_id=bookings.customer_id
                 AND c.identity_id=$4::uuid
            ))`,
        [tenantId, input.bookingId, staging, actorId],
      );
      const metadata = initial.rows[0];
      if (!metadata) fail("BOOKING_NOT_FOUND");
      const staffLock = await client.query(
        `SELECT id FROM cookie_staff.staff_profiles
          WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
        [tenantId, metadata.staff_id],
      );
      if (staffLock.rowCount !== 1) fail("BOOKING_NOT_FOUND");

      const currentResult = await client.query<BookingRow>(
        `SELECT id::text, customer_id::text, staff_id::text,
                location_id::text, service_id::text, status,
                start_at, end_at, service_duration_minutes_snapshot,
                post_service_buffer_minutes_snapshot,
                price_kopecks_snapshot::text
           FROM cookie_booking.bookings
          WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
        [tenantId, input.bookingId],
      );
      const booking = currentResult.rows[0];
      if (
        !booking ||
        booking.staff_id !== metadata.staff_id ||
        booking.location_id !== metadata.location_id
      ) {
        fail("BOOKING_NOT_FOUND");
      }

      if (staging) {
        const context = await readStagingCustomerContext(client, input.actor);
        if (context.customerId !== booking.customer_id) fail("BOOKING_NOT_FOUND");
        await requireTenantPermission(client, input.actor,
          { kind: "customer-self", tenantId, clientIdentityId: actorId },
          "staging.customer.booking.reschedule");
      } else {
        await requireTenantPermission(client, input.actor,
          { kind: "booking", tenantId, locationId: booking.location_id, staffProfileId: booking.staff_id },
          "booking.reschedule");
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [JSON.stringify([tenantId, actorId, "booking.reschedule", keyHash])],
      );
      const previous = await client.query<ReceiptRow>(
        `SELECT request_sha256, result FROM cookie_booking.command_receipts
          WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
            AND operation='booking.reschedule' AND key_sha256=$3`,
        [tenantId, actorId, keyHash],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_sha256 !== requestHash) {
          fail("IDEMPOTENCY_KEY_REUSED");
        }
        return previous.rows[0].result;
      }
      if (booking.status !== "Confirmed") fail("BOOKING_NOT_CONFIRMED");
      const oldStartAt = booking.start_at.toISOString();
      if (newStartAt === oldStartAt) fail("RESCHEDULE_NOT_AVAILABLE");

      try {
        await assertMayReschedule(client, {
          tenantId,
          bookingId: booking.id,
          staffId: booking.staff_id,
          locationId: booking.location_id,
          serviceId: booking.service_id,
          customerId: booking.customer_id,
          oldStartAt,
          oldEndAt: booking.end_at.toISOString(),
          newStartAt,
        });
      } catch {
        // Do not leak internal policy diagnostics into a future API.
        throw new RescheduleBookingFailure("RESCHEDULE_POLICY_DENIED");
      }

      const slot = await readAvailableSlot(
        client,
        tenantId,
        booking,
        newStartAt,
      );
      const updated = await client.query(
        `UPDATE cookie_booking.bookings
           SET start_at=$3::timestamptz, end_at=$4::timestamptz,
               occupied_until=$5::timestamptz
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='Confirmed'
           AND ($6::int IS NULL OR (
             start_at > clock_timestamp() + $6::int * interval '1 minute'
             AND $3::timestamptz > clock_timestamp() + $6::int * interval '1 minute'
           ))`,
        [tenantId, booking.id, slot.startAt, slot.endAt, slot.occupiedUntil, cutoffMinutes ?? null],
      );
      if (updated.rowCount !== 1)
        fail(staging ? "RESCHEDULE_POLICY_DENIED" : "RESCHEDULE_CONFLICT");

      const receipt: RescheduledBookingReceipt = {
        bookingId: booking.id,
        status: "Confirmed",
        previousStartAt: oldStartAt,
        startAt: slot.startAt,
        endAt: slot.endAt,
        occupiedUntil: slot.occupiedUntil,
        priceKopecks: booking.price_kopecks_snapshot,
      };
      await client.query(
        `INSERT INTO cookie_booking.time_change_audit
           (tenant_id,id,booking_id,actor_identity_id,correlation_id,
            old_start_at,new_start_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,
                 $6::timestamptz,$7::timestamptz)`,
        [
          tenantId,
          randomUUID(),
          booking.id,
          actorId,
          input.actor.correlationId,
          oldStartAt,
          slot.startAt,
        ],
      );
      await enqueueOutbox(client, {
        tenantId,
        dedupeKey: `booking.rescheduled:${booking.id}:${keyHash}`,
        topic: "booking.rescheduled",
        payload: {
          bookingId: booking.id,
          locationId: booking.location_id,
          staffId: booking.staff_id,
          oldStartAt,
          newStartAt: slot.startAt,
        },
      });
      await client.query(
        `INSERT INTO cookie_booking.command_receipts
           (tenant_id,actor_identity_id,operation,key_sha256,request_sha256,
            booking_id,result)
         VALUES ($1::uuid,$2::uuid,'booking.reschedule',$3,$4,$5::uuid,$6::jsonb)`,
        [
          tenantId,
          actorId,
          keyHash,
          requestHash,
          booking.id,
          JSON.stringify(receipt),
        ],
      );

      if (staging) {
        const context = await readStagingCustomerContext(client, input.actor);
        if (context.customerId !== booking.customer_id) throw new AuthorizationDeniedError();
      }
      return receipt;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23P01") {
      throw new RescheduleBookingFailure("RESCHEDULE_CONFLICT");
    }
    throw error;
  }
}
