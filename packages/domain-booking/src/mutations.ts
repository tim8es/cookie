import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  evaluateAvailableStart,
  type StaffOccupancy,
  type UtcInterval,
} from "../../domain-scheduling/src/index.js";
import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

type MutationOperation = "booking.cancel" | "booking.reschedule";

export type BookingMutationFailureCode =
  | "INVALID_BOOKING_COMMAND"
  | "BOOKING_NOT_AVAILABLE"
  | "BOOKING_NOT_CONFIRMED"
  | "BOOKING_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED";

export class BookingMutationFailure extends Error {
  constructor(readonly code: BookingMutationFailureCode) {
    super(code);
    this.name = "BookingMutationFailure";
  }
}

interface InternalMutationBase {
  readonly actor: TrustedActor;
  readonly bookingId: string;
  readonly idempotencyKey: string;
}

/** Internal business-operator cancellation. Client self-service is NOT enabled. */
export type InternalCancelBooking = InternalMutationBase;

/** Time-only reschedule: no change of service, master, branch, or price. */
export interface InternalRescheduleBooking extends InternalMutationBase {
  readonly newStartAt: string;
}

export interface CancelledBookingReceipt {
  readonly bookingId: string;
  readonly status: "CancelledByBusiness";
  readonly cancelledAt: string;
}

export interface RescheduledBookingReceipt {
  readonly bookingId: string;
  readonly status: "Confirmed";
  readonly previousStartAt: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly occupiedUntil: string;
  /** Original committed monetary snapshot, even if Catalog price changed. */
  readonly priceKopecks: string;
}

export interface BookingMutationPolicyContext {
  readonly operation: MutationOperation;
  readonly actor: TrustedActor;
  readonly bookingId: string;
  readonly locationId: string;
  readonly staffId: string;
  readonly serviceId: string;
  readonly currentStartAt: string;
  readonly requestedStartAt?: string;
}

/**
 * Required internal policy: enforces administrative permission policy,
 * deadlines and any configured business/entitlement restrictions in this
 * transaction. No default (nor customer self-service) is provided in F1.
 */
export type AssertMutationPolicy = (
  client: PoolClient,
  context: BookingMutationPolicyContext,
) => Promise<void>;

/**
 * Mandatory CancelBooking hook: restore actually consumed one-time promotions
 * atomically, including redemption ledger/audit once the F2 module exists.
 * F1 synthetic tests use a no-promo assertion. No production adapter exists.
 */
export type RestoreConsumedPromotions = (
  client: PoolClient,
  context: BookingMutationPolicyContext,
) => Promise<void>;

interface BookingRow extends QueryResultRow {
  id: string;
  customer_id: string;
  location_id: string;
  staff_id: string;
  service_id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  occupied_until: Date;
  service_duration_minutes_snapshot: number;
  post_service_buffer_minutes_snapshot: number;
  price_kopecks_snapshot: string;
}

interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  result: CancelledBookingReceipt | RescheduledBookingReceipt;
}

interface WindowRow extends QueryResultRow {
  start_at: Date;
  end_at: Date;
}

interface BlockedRow extends WindowRow {
  kind: "break" | "exception";
}

interface OccupiedRow extends QueryResultRow {
  location_id: string;
  start_at: Date;
  occupied_until: Date;
}

function fail(code: BookingMutationFailureCode): never {
  throw new BookingMutationFailure(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateBase(input: InternalMutationBase): void {
  if (
    !UUID.test(input.actor?.tenantId) ||
    !UUID.test(input.actor.identityId) ||
    typeof input.actor.correlationId !== "string" ||
    input.actor.correlationId.length < 1 ||
    input.actor.correlationId.length > 128 ||
    !UUID.test(input.bookingId) ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128
  ) {
    fail("INVALID_BOOKING_COMMAND");
  }
}

function validateStart(value: string): string {
  if (typeof value !== "string" || !UTC_MINUTE.test(value)) {
    return fail("INVALID_BOOKING_COMMAND");
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    return fail("INVALID_BOOKING_COMMAND");
  }
  return new Date(timestamp).toISOString();
}

function localDateAt(startAt: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(startAt));
  const value = (kind: string): string =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function intervals(rows: readonly WindowRow[]): UtcInterval[] {
  return rows.map((row) => ({
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
  }));
}

async function fetchBooking(
  client: PoolClient,
  tenantId: string,
  bookingId: string,
  lock: boolean,
): Promise<BookingRow> {
  const found = await client.query<BookingRow>(
    `SELECT id::text, customer_id::text, location_id::text,
            staff_id::text, service_id::text, status, start_at,
            end_at, occupied_until, service_duration_minutes_snapshot,
            post_service_buffer_minutes_snapshot,
            price_kopecks_snapshot::text
       FROM cookie_booking.bookings
      WHERE tenant_id=$1::uuid AND id=$2::uuid
      ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, bookingId],
  );
  return found.rows[0] ?? fail("BOOKING_NOT_AVAILABLE");
}

async function availableForReschedule(
  client: PoolClient,
  booking: BookingRow,
  actor: TrustedActor,
  newStartAt: string,
): Promise<{ endAt: string; occupiedUntil: string }> {
  const time = await client.query<{ now: Date }>(
    "SELECT clock_timestamp() AS now",
  );
  if (
    Date.parse(newStartAt) <=
    (time.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY)
  ) {
    fail("BOOKING_NOT_AVAILABLE");
  }
  const active = await client.query<{ time_zone: string | null }>(
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
      WHERE assignment.tenant_id=$1::uuid
        AND assignment.location_id=$2::uuid
        AND assignment.staff_id=$3::uuid
        AND assignment.service_id=$4::uuid
        AND assignment.active AND staff_loc.active AND staff.active
        AND staff.bookable AND service.active
      FOR SHARE OF assignment, staff_loc, staff, service, loc`,
    [actor.tenantId, booking.location_id, booking.staff_id, booking.service_id],
  );
  const zone = active.rows[0]?.time_zone;
  if (!zone) fail("BOOKING_NOT_AVAILABLE");

  const shifts = await client.query<WindowRow>(
    `SELECT start_at, end_at FROM cookie_scheduling.shift_windows
      WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
        AND location_id=$3::uuid AND active
      FOR SHARE`,
    [actor.tenantId, booking.staff_id, booking.location_id],
  );
  const blocked = await client.query<BlockedRow>(
    `SELECT start_at, end_at, kind FROM cookie_scheduling.blocked_windows
      WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
        AND location_id=$3::uuid AND active
      FOR SHARE`,
    [actor.tenantId, booking.staff_id, booking.location_id],
  );
  const busy = await client.query<OccupiedRow>(
    `SELECT location_id::text, start_at, occupied_until
       FROM cookie_booking.bookings
      WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
        AND status='Confirmed' AND id <> $3::uuid`,
    [actor.tenantId, booking.staff_id, booking.id],
  );
  const occupied: StaffOccupancy[] = busy.rows.map((row) => ({
    organizationId: actor.tenantId,
    staffId: booking.staff_id,
    locationId: row.location_id,
    startAt: row.start_at.toISOString(),
    occupiedUntil: row.occupied_until.toISOString(),
  }));
  const slot = evaluateAvailableStart(
    {
      organizationId: actor.tenantId,
      staffId: booking.staff_id,
      locationId: booking.location_id,
      localDate: localDateAt(newStartAt, zone),
      timeZone: zone,
      serviceDurationMinutes: booking.service_duration_minutes_snapshot,
      postServiceBufferMinutes: booking.post_service_buffer_minutes_snapshot,
      stepMinutes: 1,
      shifts: intervals(shifts.rows),
      breaks: intervals(blocked.rows.filter((row) => row.kind === "break")),
      exceptions: intervals(
        blocked.rows.filter((row) => row.kind === "exception"),
      ),
      occupied,
    },
    newStartAt,
  );
  if (!slot) fail("BOOKING_NOT_AVAILABLE");
  return slot;
}

async function executeMutation(
  pool: Pool,
  input: InternalMutationBase,
  operation: MutationOperation,
  assertPolicy: AssertMutationPolicy,
  newStartAt?: string,
  restorePromotions?: RestoreConsumedPromotions,
): Promise<CancelledBookingReceipt | RescheduledBookingReceipt> {
  if (
    typeof assertPolicy !== "function" ||
    (operation === "booking.cancel" &&
      typeof restorePromotions !== "function")
  ) {
    fail("INVALID_BOOKING_COMMAND");
  }
  validateBase(input);
  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = sha256(input.idempotencyKey);
  const requestHash = sha256(JSON.stringify([input.bookingId, newStartAt ?? null]));
  const client = await pool.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    // Obtain only tenant-owned resource metadata; never trust unverified
    // location/staff declarations from the incoming command.
    const preliminary = await fetchBooking(
      client,
      tenantId,
      input.bookingId,
      false,
    );
    await requireTenantPermission(
      client,
      input.actor,
      {
        kind: "booking",
        tenantId,
        locationId: preliminary.location_id,
        staffProfileId: preliminary.staff_id,
      },
      "booking.edit",
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [JSON.stringify([tenantId, actorId, operation, keyHash])],
    );
    const previous = await client.query<ReceiptRow>(
      `SELECT request_sha256, result FROM cookie_booking.command_receipts
        WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
          AND operation=$3 AND key_sha256=$4`,
      [tenantId, actorId, operation, keyHash],
    );
    const receipt = previous.rows[0];
    if (receipt) {
      if (receipt.request_sha256 !== requestHash) {
        fail("IDEMPOTENCY_KEY_REUSED");
      }
      await client.query("COMMIT");
      started = false;
      return receipt.result;
    }

    // CreateBooking uses this same staff-row lock. All future ScheduleChange
    // handlers must participate in this order too, but are not yet wired.
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, preliminary.staff_id],
    );
    if (staff.rowCount !== 1) fail("BOOKING_NOT_AVAILABLE");
    const booking = await fetchBooking(client, tenantId, input.bookingId, true);
    if (
      booking.staff_id !== preliminary.staff_id ||
      booking.location_id !== preliminary.location_id
    ) {
      fail("BOOKING_CONFLICT");
    }
    if (booking.status !== "Confirmed") fail("BOOKING_NOT_CONFIRMED");

    const context: BookingMutationPolicyContext = {
      operation,
      actor: input.actor,
      bookingId: booking.id,
      locationId: booking.location_id,
      staffId: booking.staff_id,
      serviceId: booking.service_id,
      currentStartAt: booking.start_at.toISOString(),
      ...(newStartAt ? { requestedStartAt: newStartAt } : {}),
    };
    await assertPolicy(client, context);

    let result: CancelledBookingReceipt | RescheduledBookingReceipt;
    let topic: string;
    let payload: { bookingId: string; oldStartAt: string; newStartAt?: string };
    if (operation === "booking.cancel") {
      // A production promotions adapter must atomically refund consumed
      // one-time redemption rights before cancellation can commit.
      await restorePromotions!(client, context);
      const changed = await client.query<{ cancelled_at: Date }>(
        `UPDATE cookie_booking.bookings
           SET status='CancelledByBusiness', cancelled_at=clock_timestamp()
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='Confirmed'
         RETURNING cancelled_at`,
        [tenantId, booking.id],
      );
      if (changed.rowCount !== 1) fail("BOOKING_CONFLICT");
      result = {
        bookingId: booking.id,
        status: "CancelledByBusiness",
        cancelledAt: changed.rows[0]!.cancelled_at.toISOString(),
      };
      topic = "booking.cancelled";
      payload = { bookingId: booking.id, oldStartAt: context.currentStartAt };
    } else {
      if (!newStartAt || newStartAt === context.currentStartAt) {
        fail("BOOKING_NOT_AVAILABLE");
      }
      const slot = await availableForReschedule(
        client,
        booking,
        input.actor,
        newStartAt,
      );
      const changed = await client.query(
        `UPDATE cookie_booking.bookings
           SET start_at=$3::timestamptz, end_at=$4::timestamptz,
               occupied_until=$5::timestamptz
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='Confirmed'`,
        [tenantId, booking.id, newStartAt, slot.endAt, slot.occupiedUntil],
      );
      if (changed.rowCount !== 1) fail("BOOKING_CONFLICT");
      result = {
        bookingId: booking.id,
        status: "Confirmed",
        previousStartAt: context.currentStartAt,
        startAt: slot.startAt,
        endAt: slot.endAt,
        occupiedUntil: slot.occupiedUntil,
        priceKopecks: booking.price_kopecks_snapshot,
      };
      topic = "booking.rescheduled";
      payload = {
        bookingId: booking.id,
        oldStartAt: context.currentStartAt,
        newStartAt: slot.startAt,
      };
    }

    await client.query(
      `INSERT INTO cookie_booking.mutation_audit
          (tenant_id,id,booking_id,actor_identity_id,correlation_id,
           operation,old_start_at,new_start_at,old_status,new_status)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,
               $7::timestamptz,$8::timestamptz,'Confirmed',$9)`,
      [
        tenantId,
        randomUUID(),
        booking.id,
        actorId,
        input.actor.correlationId,
        operation,
        context.currentStartAt,
        operation === "booking.reschedule" ? newStartAt : null,
        result.status,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      dedupeKey:
        operation === "booking.cancel"
          ? `booking.cancelled:${booking.id}`
          : `booking.rescheduled:${booking.id}:${keyHash}`,
      topic,
      payload,
    });
    await client.query(
      `INSERT INTO cookie_booking.command_receipts
         (tenant_id,actor_identity_id,operation,key_sha256,request_sha256,
          booking_id,result)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
      [
        tenantId,
        actorId,
        operation,
        keyHash,
        requestHash,
        booking.id,
        JSON.stringify(result),
      ],
    );
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23P01") {
      throw new BookingMutationFailure("BOOKING_CONFLICT");
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Internal business cancellation; requires a real promo-restoration adapter. */
export async function cancelBookingInternal(
  pool: Pool,
  input: InternalCancelBooking,
  assertPolicy: AssertMutationPolicy,
  restorePromotions: RestoreConsumedPromotions,
): Promise<CancelledBookingReceipt> {
  return (await executeMutation(
    pool,
    input,
    "booking.cancel",
    assertPolicy,
    undefined,
    restorePromotions,
  )) as CancelledBookingReceipt;
}

/** Internal time-only reschedule. Original price/promotions remain untouched. */
export async function rescheduleBookingInternal(
  pool: Pool,
  input: InternalRescheduleBooking,
  assertPolicy: AssertMutationPolicy,
): Promise<RescheduledBookingReceipt> {
  const newStartAt = validateStart(input.newStartAt);
  return (await executeMutation(
    pool,
    input,
    "booking.reschedule",
    assertPolicy,
    newStartAt,
  )) as RescheduledBookingReceipt;
}
