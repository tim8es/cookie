import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  evaluateAvailableStart,
  type StaffOccupancy,
  type UtcInterval,
} from "../../domain-scheduling/src/index.js";
import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

export type CreateBookingFailureCode =
  | "INVALID_BOOKING_COMMAND"
  | "BOOKING_NOT_AVAILABLE"
  | "BOOKING_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED";

export class CreateBookingFailure extends Error {
  constructor(readonly code: CreateBookingFailureCode) {
    super(code);
    this.name = "CreateBookingFailure";
  }
}

/** Internal trusted-actor command only. Never bind this input to public JSON. */
export interface InternalCreateBooking {
  readonly actor: TrustedActor;
  readonly customerId: string;
  readonly locationId: string;
  readonly staffId: string;
  readonly serviceId: string;
  /** Explicit UTC minute, not a timezone-less wall-clock value. */
  readonly startAt: string;
  readonly idempotencyKey: string;
}

export interface ConfirmedBookingReceipt {
  readonly bookingId: string;
  readonly status: "Confirmed";
  readonly startAt: string;
  readonly endAt: string;
  readonly occupiedUntil: string;
  readonly priceKopecks: string;
}

/**
 * Mandatory trusted server-side entitlement check, called INSIDE the command
 * transaction for new creates. It must throw for expired trial/unpaid tenants.
 * No implementation is supplied here, so production/API cannot enable this
 * command until a real entitlement adapter exists.
 */
export type AssertBookingEntitlement = (
  client: PoolClient,
  tenantId: string,
) => Promise<void>;

interface ServiceRow extends QueryResultRow {
  duration_minutes: number;
  post_service_buffer_minutes: number;
  base_price_kopecks: string;
  time_zone: string | null;
}
interface WindowRow extends QueryResultRow {
  start_at: Date;
  end_at: Date;
}
interface OccupiedRow extends QueryResultRow {
  location_id: string;
  start_at: Date;
  occupied_until: Date;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  result: ConfirmedBookingReceipt;
}
interface ClockRow extends QueryResultRow {
  now: Date;
}

function invalid(): never {
  throw new CreateBookingFailure("INVALID_BOOKING_COMMAND");
}

function assertInput(input: InternalCreateBooking): string {
  const { actor } = input;
  if (
    !UUID.test(actor.tenantId) ||
    !UUID.test(actor.identityId) ||
    !actor.correlationId ||
    actor.correlationId.length > 128 ||
    !UUID.test(input.customerId) ||
    !UUID.test(input.locationId) ||
    !UUID.test(input.staffId) ||
    !UUID.test(input.serviceId) ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128 ||
    !UTC_MINUTE.test(input.startAt)
  ) {
    return invalid();
  }
  const date = new Date(input.startAt);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== input.startAt.slice(0, 19)
  ) {
    return invalid();
  }
  return date.toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function localDateAt(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function toIntervals(rows: readonly WindowRow[]): UtcInterval[] {
  return rows.map((row) => ({
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
  }));
}

async function loadService(
  client: PoolClient,
  input: InternalCreateBooking,
): Promise<ServiceRow> {
  const result = await client.query<ServiceRow>(
    `SELECT service.duration_minutes, service.post_service_buffer_minutes,
            service.base_price_kopecks::text, loc.time_zone
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
        AND assignment.active AND staff_loc.active
        AND staff.active AND staff.bookable AND service.active
      FOR SHARE OF assignment, staff_loc, staff, service, loc`,
    [input.actor.tenantId, input.locationId, input.staffId, input.serviceId],
  );
  const found = result.rows[0];
  if (!found?.time_zone) {
    throw new CreateBookingFailure("BOOKING_NOT_AVAILABLE");
  }
  return found;
}

async function checkSlot(
  client: PoolClient,
  input: InternalCreateBooking,
  startAt: string,
  service: ServiceRow,
): Promise<{ endAt: string; occupiedUntil: string }> {
  const now = await client.query<ClockRow>("SELECT clock_timestamp() AS now");
  if (new Date(startAt).getTime() <= (now.rows[0]?.now.getTime() ?? Infinity)) {
    throw new CreateBookingFailure("BOOKING_NOT_AVAILABLE");
  }

  const [shiftResult, blockResult, occupiedResult] = await Promise.all([
    client.query<WindowRow>(
      `SELECT start_at, end_at FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
          AND location_id=$3::uuid AND active
        FOR SHARE`,
      [input.actor.tenantId, input.staffId, input.locationId],
    ),
    client.query<WindowRow & { kind: "break" | "exception" }>(
      `SELECT start_at, end_at, kind FROM cookie_scheduling.blocked_windows
        WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
          AND location_id=$3::uuid AND active
        FOR SHARE`,
      [input.actor.tenantId, input.staffId, input.locationId],
    ),
    client.query<OccupiedRow>(
      `SELECT location_id::text, start_at, occupied_until
         FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
          AND status='Confirmed'`,
      [input.actor.tenantId, input.staffId],
    ),
  ]);

  const blocked = blockResult.rows;
  const occupied: StaffOccupancy[] = occupiedResult.rows.map((row) => ({
    organizationId: input.actor.tenantId,
    staffId: input.staffId,
    locationId: row.location_id,
    startAt: row.start_at.toISOString(),
    occupiedUntil: row.occupied_until.toISOString(),
  }));
  const slot = evaluateAvailableStart(
    {
      organizationId: input.actor.tenantId,
      staffId: input.staffId,
      locationId: input.locationId,
      localDate: localDateAt(startAt, service.time_zone!),
      timeZone: service.time_zone!,
      serviceDurationMinutes: service.duration_minutes,
      postServiceBufferMinutes: service.post_service_buffer_minutes,
      stepMinutes: 1,
      shifts: toIntervals(shiftResult.rows),
      breaks: toIntervals(blocked.filter((row) => row.kind === "break")),
      exceptions: toIntervals(
        blocked.filter((row) => row.kind === "exception"),
      ),
      occupied,
    },
    startAt,
  );
  if (!slot) throw new CreateBookingFailure("BOOKING_NOT_AVAILABLE");
  return slot;
}

/**
 * Internal F1 vertical slice. Every mutable check and durable receipt runs
 * inside ONE PostgreSQL transaction. Same-key requests serialize on a
 * transaction-scoped advisory lock, independent keys serialize on staff row.
 * PostgreSQL GiST exclusion remains the final cross-process conflict guard.
 *
 * This MUST NOT be mounted as a public API before verified AuthN, a real
 * entitlement adapter, customer ownership and protected schedule edits exist.
 */
export async function createBookingInternal(
  pool: Pool,
  input: InternalCreateBooking,
  assertEntitled: AssertBookingEntitlement,
): Promise<ConfirmedBookingReceipt> {
  if (typeof assertEntitled !== "function") return invalid();
  const startAt = assertInput(input);
  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = sha256(input.idempotencyKey);
  const requestHash = sha256(
    JSON.stringify([
      input.customerId,
      input.locationId,
      input.staffId,
      input.serviceId,
      startAt,
    ]),
  );
  const client = await pool.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;

    // A location-scoped permission is checked even on idempotent replay.
    // Client/customer roles cannot pass without verified customer binding.
    await requireTenantPermission(
      client,
      input.actor,
      {
        kind: "booking",
        tenantId,
        locationId: input.locationId,
        staffProfileId: input.staffId,
      },
      "booking.create",
    );

    // Hash collisions only cause unnecessary serialization, never a false
    // idempotent response: the full scoped digest is the unique receipt key.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [JSON.stringify([tenantId, actorId, "booking.create", keyHash])],
    );
    const prior = await client.query<ReceiptRow>(
      `SELECT request_sha256, result
         FROM cookie_booking.command_receipts
        WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
          AND operation='booking.create' AND key_sha256=$3`,
      [tenantId, actorId, keyHash],
    );
    const existing = prior.rows[0];
    if (existing) {
      if (existing.request_sha256 !== requestHash) {
        throw new CreateBookingFailure("IDEMPOTENCY_KEY_REUSED");
      }
      await client.query("COMMIT");
      started = false;
      return existing.result;
    }

    // All CreateBooking and protected ScheduleChange handlers must share
    // this staff lock order; the latter is still an open F1 requirement.
    const locked = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.staffId],
    );
    if (locked.rowCount !== 1) {
      throw new CreateBookingFailure("BOOKING_NOT_AVAILABLE");
    }
    const service = await loadService(client, input);
    const customer = await client.query(
      `SELECT id FROM cookie_customers.customers
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`,
      [tenantId, input.customerId],
    );
    if (customer.rowCount !== 1) {
      throw new CreateBookingFailure("BOOKING_NOT_AVAILABLE");
    }

    // Mandatory callback has no default implementation and must fail closed
    // until trial/paid entitlements are implemented and verified.
    await assertEntitled(client, tenantId);
    const slot = await checkSlot(client, input, startAt, service);
    const bookingId = randomUUID();
    const result: ConfirmedBookingReceipt = {
      bookingId,
      status: "Confirmed",
      startAt,
      endAt: slot.endAt,
      occupiedUntil: slot.occupiedUntil,
      priceKopecks: service.base_price_kopecks,
    };

    await client.query(
      `INSERT INTO cookie_booking.bookings
         (tenant_id,id,customer_id,staff_id,location_id,service_id,status,
          start_at,end_at,occupied_until,service_duration_minutes_snapshot,
          post_service_buffer_minutes_snapshot,price_kopecks_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,'Confirmed',$7,$8,$9,$10,$11,$12)`,
      [
        tenantId,
        bookingId,
        input.customerId,
        input.staffId,
        input.locationId,
        input.serviceId,
        startAt,
        result.endAt,
        result.occupiedUntil,
        service.duration_minutes,
        service.post_service_buffer_minutes,
        result.priceKopecks,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      dedupeKey: `booking.created:${bookingId}`,
      topic: "booking.confirmed",
      payload: {
        bookingId,
        locationId: input.locationId,
        staffId: input.staffId,
      },
    });
    await client.query(
      `INSERT INTO cookie_booking.command_receipts
         (tenant_id,actor_identity_id,operation,key_sha256,request_sha256,
          booking_id,result)
       VALUES ($1,$2,'booking.create',$3,$4,$5,$6::jsonb)`,
      [
        tenantId,
        actorId,
        keyHash,
        requestHash,
        bookingId,
        JSON.stringify(result),
      ],
    );
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23P01") {
      throw new CreateBookingFailure("BOOKING_CONFLICT");
    }
    throw error;
  } finally {
    client.release();
  }
}
