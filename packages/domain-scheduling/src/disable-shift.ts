import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DisableShiftFailureCode =
  | "INVALID_SHIFT_COMMAND"
  | "SHIFT_NOT_FOUND"
  | "SHIFT_NOT_ACTIVE"
  | "SHIFT_NOT_FUTURE"
  | "SHIFT_BOOKING_CONFLICT"
  | "SHIFT_POLICY_DENIED"
  | "SHIFT_KEY_REUSED";

export class DisableShiftFailure extends Error {
  constructor(readonly code: DisableShiftFailureCode) {
    super(code);
    this.name = "DisableShiftFailure";
  }
}

export interface InternalDisableShift {
  /** Only a server-verified trusted actor; never a client-supplied claim. */
  readonly actor: TrustedActor;
  readonly shiftId: string;
  readonly idempotencyKey: string;
}

export interface DisabledShiftReceipt {
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly active: false;
}

/**
 * Required trusted policy adapter; fail closed on rejected publication,
 * entitlement, contractual or administrative exceptions. Runs within SQL
 * transaction. No network calls or permissive production default supplied.
 */
export type AssertMayDisableShift = (
  client: PoolClient,
  context: {
    readonly tenantId: string;
    readonly shiftId: string;
    readonly staffId: string;
    readonly locationId: string;
    readonly startAt: string;
    readonly endAt: string;
  },
) => Promise<void>;

interface ShiftRow extends QueryResultRow {
  id: string;
  staff_id: string;
  location_id: string;
  start_at: Date;
  end_at: Date;
  active: boolean;
}

interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  result: DisabledShiftReceipt;
}

function reject(code: DisableShiftFailureCode): never {
  throw new DisableShiftFailure(code);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * INTERNAL command. Never disable a future shift if even one Confirmed
 * booking's occupied interval (including buffer) would lose coverage.
 *
 * The same StaffProfile row lock serializes with CreateBooking,
 * RescheduleBooking, CancelBooking and addScheduleBlockInternal.
 * An actor's permission is derived from the tenant/location/staff stored
 * in PostgreSQL, not from client input.
 */
export async function disableShiftInternal(
  pool: Pool,
  input: InternalDisableShift,
  assertMayDisable: AssertMayDisableShift,
  /** Trusted composition only; caller controls the shared transaction. */
  transactionClient?: PoolClient,
): Promise<DisabledShiftReceipt> {
  if (
    !input ||
    !input.actor ||
    !UUID.test(input.actor.tenantId) ||
    !UUID.test(input.actor.identityId) ||
    typeof input.actor.correlationId !== "string" ||
    input.actor.correlationId.length < 1 ||
    input.actor.correlationId.length > 128 ||
    !UUID.test(input.shiftId) ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128 ||
    typeof assertMayDisable !== "function"
  ) {
    reject("INVALID_SHIFT_COMMAND");
  }

  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = hash(input.idempotencyKey);
  const requestHash = hash(JSON.stringify([input.shiftId]));
  const client = transactionClient ?? (await pool.connect());
  const ownsTransaction = transactionClient === undefined;
  let active = false;

  try {
    if (ownsTransaction) await client.query("BEGIN");
    active = true;

    const lookup = await client.query<ShiftRow>(
      `SELECT id::text, staff_id::text, location_id::text, start_at, end_at, active
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.shiftId],
    );
    const reference = lookup.rows[0];
    if (!reference) reject("SHIFT_NOT_FOUND");

    // Guard lock order: staff first, then shift. CreateBooking and all
    // protected scheduling commands acquire the same tenant/staff row.
    const lockedStaff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (lockedStaff.rowCount !== 1) reject("SHIFT_NOT_FOUND");

    const shifted = await client.query<ShiftRow>(
      `SELECT id::text, staff_id::text, location_id::text,
              start_at, end_at, active
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.shiftId],
    );
    const shift = shifted.rows[0];
    if (
      !shift ||
      shift.staff_id !== reference.staff_id ||
      shift.location_id !== reference.location_id
    ) {
      reject("SHIFT_NOT_FOUND");
    }

    await requireTenantPermission(
      client,
      input.actor,
      {
        kind: "schedule",
        tenantId,
        staffProfileId: shift.staff_id,
        locationId: shift.location_id,
      },
      "schedule.manage",
    );

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [JSON.stringify([tenantId, actorId, "schedule.shift.disable", keyHash])],
    );
    const previous = await client.query<ReceiptRow>(
      `SELECT request_sha256, result
         FROM cookie_scheduling.shift_disable_receipts
        WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
          AND key_sha256=$3`,
      [tenantId, actorId, keyHash],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_sha256 !== requestHash) {
        reject("SHIFT_KEY_REUSED");
      }
      if (ownsTransaction) await client.query("COMMIT");
      active = false;
      return previous.rows[0].result;
    }

    if (!shift.active) reject("SHIFT_NOT_ACTIVE");

    const now = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    if (
      shift.start_at.getTime() <=
      (now.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY)
    ) {
      reject("SHIFT_NOT_FUTURE");
    }

    try {
      await assertMayDisable(client, {
        tenantId,
        shiftId: shift.id,
        staffId: shift.staff_id,
        locationId: shift.location_id,
        startAt: shift.start_at.toISOString(),
        endAt: shift.end_at.toISOString(),
      });
    } catch {
      // Don't leak internal policy conditions in a future public API.
      throw new DisableShiftFailure("SHIFT_POLICY_DENIED");
    }

    // Only Confirmed bookings that *overlap the target shift* can lose
    // coverage when it is disabled. Each must still fit completely inside
    // at least one OTHER active shift at the same location.
    const orphaned = await client.query(
      `SELECT booking.id
         FROM cookie_booking.bookings AS booking
        WHERE booking.tenant_id=$1::uuid
          AND booking.staff_id=$2::uuid AND booking.location_id=$3::uuid
          AND booking.status='Confirmed'
          AND booking.occupied_until > clock_timestamp()
          AND tstzrange(booking.start_at, booking.occupied_until, '[)')
              && tstzrange($4::timestamptz, $5::timestamptz, '[)')
          AND NOT EXISTS (
            SELECT 1 FROM cookie_scheduling.shift_windows AS alternative
             WHERE alternative.tenant_id=booking.tenant_id
               AND alternative.staff_id=booking.staff_id
               AND alternative.location_id=booking.location_id
               AND alternative.id<>$6::uuid AND alternative.active
               AND alternative.start_at<=booking.start_at
               AND alternative.end_at>=booking.occupied_until
          )
        LIMIT 1`,
      [
        tenantId,
        shift.staff_id,
        shift.location_id,
        shift.start_at,
        shift.end_at,
        shift.id,
      ],
    );
    if (orphaned.rowCount) reject("SHIFT_BOOKING_CONFLICT");

    const updated = await client.query(
      `UPDATE cookie_scheduling.shift_windows SET active=false
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND active`,
      [tenantId, shift.id],
    );
    if (updated.rowCount !== 1) reject("SHIFT_NOT_ACTIVE");

    const receipt: DisabledShiftReceipt = {
      shiftId: shift.id,
      staffId: shift.staff_id,
      locationId: shift.location_id,
      startAt: shift.start_at.toISOString(),
      endAt: shift.end_at.toISOString(),
      active: false,
    };

    await client.query(
      `INSERT INTO cookie_scheduling.shift_disable_audit
         (tenant_id,id,shift_id,actor_identity_id,correlation_id,
          previous_active,next_active)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,true,false)`,
      [tenantId, randomUUID(), shift.id, actorId, input.actor.correlationId],
    );
    await enqueueOutbox(client, {
      tenantId,
      dedupeKey: `schedule.shift.disabled:${shift.id}`,
      topic: "schedule.shift.disabled",
      payload: {
        shiftId: shift.id,
        staffId: shift.staff_id,
        locationId: shift.location_id,
      },
    });
    await client.query(
      `INSERT INTO cookie_scheduling.shift_disable_receipts
         (tenant_id,actor_identity_id,key_sha256,request_sha256,
          shift_id,result)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb)`,
      [
        tenantId,
        actorId,
        keyHash,
        requestHash,
        shift.id,
        JSON.stringify(receipt),
      ],
    );

    if (ownsTransaction) await client.query("COMMIT");
    active = false;
    return receipt;
  } catch (error) {
    if (active && ownsTransaction) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}
