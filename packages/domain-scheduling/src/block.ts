import { createHash } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

export type AddScheduleBlockFailureCode =
  | "INVALID_SCHEDULE_BLOCK"
  | "SCHEDULE_TARGET_UNAVAILABLE"
  | "SCHEDULE_BOOKING_CONFLICT"
  | "SCHEDULE_KEY_REUSED"
  | "SCHEDULE_BLOCK_CHANGED";

export class AddScheduleBlockFailure extends Error {
  constructor(readonly code: AddScheduleBlockFailureCode) {
    super(code);
    this.name = "AddScheduleBlockFailure";
  }
}

export interface InternalAddScheduleBlock {
  /** Server-verified actor; never accept this from client/AI-supplied JSON. */
  readonly actor: TrustedActor;
  readonly staffId: string;
  readonly locationId: string;
  readonly kind: "break" | "exception";
  readonly startAt: string;
  readonly endAt: string;
  /** Caller-owned stable key scoped to tenant/actor/operation. */
  readonly idempotencyKey: string;
}

export interface AddedScheduleBlockReceipt {
  readonly id: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly kind: "break" | "exception";
  readonly startAt: string;
  readonly endAt: string;
  readonly active: true;
}

interface BlockRow extends QueryResultRow {
  staff_id: string;
  location_id: string;
  kind: "break" | "exception";
  start_at: Date;
  end_at: Date;
  active: boolean;
}

function reject(code: AddScheduleBlockFailureCode): never {
  throw new AddScheduleBlockFailure(code);
}

function parseMinute(value: string): string {
  if (typeof value !== "string" || !UTC_MINUTE.test(value)) {
    return reject("INVALID_SCHEDULE_BLOCK");
  }
  const ms = Date.parse(value);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    return reject("INVALID_SCHEDULE_BLOCK");
  }
  return new Date(ms).toISOString();
}

/**
 * Derive a stable internal UUID from a scoped cryptographic digest without
 * storing or logging the caller's raw idempotency key.
 */
function stableBlockId(
  tenantId: string,
  actorId: string,
  key: string,
): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([tenantId, actorId, "schedule.block.add", key]))
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * A narrow internal schedule mutation, not the F2 edit/review/approval UI.
 * Adds one future exception/break without silently invalidating Confirmed
 * bookings. Staff row lock is shared with Create/Cancel/Reschedule commands.
 *
 * Direct SQL writers and other scheduling commands MUST follow this locking
 * protocol before such edits can be exposed in a production system.
 */
export async function addScheduleBlockInternal(
  pool: Pool,
  input: InternalAddScheduleBlock,
): Promise<AddedScheduleBlockReceipt> {
  if (
    !input ||
    !input.actor ||
    !UUID.test(input.actor.tenantId) ||
    !UUID.test(input.actor.identityId) ||
    typeof input.actor.correlationId !== "string" ||
    input.actor.correlationId.length < 1 ||
    input.actor.correlationId.length > 128 ||
    !UUID.test(input.staffId) ||
    !UUID.test(input.locationId) ||
    (input.kind !== "break" && input.kind !== "exception") ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128
  ) {
    return reject("INVALID_SCHEDULE_BLOCK");
  }

  const startAt = parseMinute(input.startAt);
  const endAt = parseMinute(input.endAt);
  const ms = Date.parse(endAt) - Date.parse(startAt);
  if (ms <= 0 || ms > 48 * 60 * 60 * 1000) {
    return reject("INVALID_SCHEDULE_BLOCK");
  }
  const tenantId = input.actor.tenantId;
  const id = stableBlockId(
    tenantId,
    input.actor.identityId,
    input.idempotencyKey,
  );
  const client = await pool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;

    // Only verified staff/tenant resource is lockable. Locks serialize with
    // CreateBooking and RescheduleBooking regardless of branch.
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.staffId],
    );
    if (staff.rowCount !== 1) {
      return reject("SCHEDULE_TARGET_UNAVAILABLE");
    }
    await requireTenantPermission(
      client,
      input.actor,
      {
        kind: "schedule",
        tenantId,
        staffProfileId: input.staffId,
        locationId: input.locationId,
      },
      "schedule.manage",
    );

    const existing = await client.query<BlockRow>(
      `SELECT staff_id::text, location_id::text, kind, start_at, end_at, active
         FROM cookie_scheduling.blocked_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, id],
    );
    const previous = existing.rows[0];
    if (previous) {
      if (
        previous.staff_id !== input.staffId ||
        previous.location_id !== input.locationId ||
        previous.kind !== input.kind ||
        previous.start_at.toISOString() !== startAt ||
        previous.end_at.toISOString() !== endAt
      ) {
        return reject("SCHEDULE_KEY_REUSED");
      }
      if (!previous.active) return reject("SCHEDULE_BLOCK_CHANGED");
      await client.query("COMMIT");
      active = false;
      return {
        id,
        staffId: input.staffId,
        locationId: input.locationId,
        kind: input.kind,
        startAt,
        endAt,
        active: true,
      };
    }

    const target = await client.query<{ time_zone: string | null }>(
      `SELECT location.time_zone
         FROM cookie_staff.location_assignments AS assignment
         JOIN cookie_tenancy.locations AS location
           ON location.tenant_id=assignment.tenant_id
          AND location.id=assignment.location_id
        WHERE assignment.tenant_id=$1::uuid
          AND assignment.staff_id=$2::uuid
          AND assignment.location_id=$3::uuid
          AND assignment.active
        FOR SHARE OF assignment, location`,
      [tenantId, input.staffId, input.locationId],
    );
    const zone = target.rows[0]?.time_zone;
    if (!zone) reject("SCHEDULE_TARGET_UNAVAILABLE");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    } catch {
      reject("SCHEDULE_TARGET_UNAVAILABLE");
    }

    const now = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    if (Date.parse(startAt) <= (now.rows[0]?.now.getTime() ?? Infinity)) {
      reject("SCHEDULE_TARGET_UNAVAILABLE");
    }

    // OccupiedUntil includes the post-service buffer. Only bookings at the
    // edited location would become unavailable because this block is local.
    const collisions = await client.query(
      `SELECT id FROM cookie_booking.bookings
         WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
           AND location_id=$3::uuid AND status='Confirmed'
           AND tstzrange(start_at, occupied_until, '[)')
             && tstzrange($4::timestamptz, $5::timestamptz, '[)')
         LIMIT 1`,
      [tenantId, input.staffId, input.locationId, startAt, endAt],
    );
    if (collisions.rowCount) reject("SCHEDULE_BOOKING_CONFLICT");

    await client.query(
      `INSERT INTO cookie_scheduling.blocked_windows
         (tenant_id, id, staff_id, location_id, kind, start_at, end_at, active)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
               $6::timestamptz, $7::timestamptz, true)`,
      [
        tenantId,
        id,
        input.staffId,
        input.locationId,
        input.kind,
        startAt,
        endAt,
      ],
    );
    await client.query("COMMIT");
    active = false;
    return {
      id,
      staffId: input.staffId,
      locationId: input.locationId,
      kind: input.kind,
      startAt,
      endAt,
      active: true,
    };
  } catch (error) {
    if (active) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
