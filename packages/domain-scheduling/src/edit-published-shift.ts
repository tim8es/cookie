import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
const MAX_INTERVAL_MS = 48 * 60 * 60 * 1000;

export type EditPublishedShiftFailureCode =
  | "INVALID_PUBLISHED_SHIFT_EDIT"
  | "PUBLISHED_SHIFT_NOT_FOUND"
  | "PUBLISHED_SHIFT_NOT_EDITABLE"
  | "PUBLISHED_SHIFT_STALE_REVISION"
  | "PUBLISHED_SHIFT_NOT_FUTURE"
  | "PUBLISHED_SHIFT_TARGET_UNAVAILABLE"
  | "PUBLISHED_SHIFT_BOOKING_CONFLICT"
  | "PUBLISHED_SHIFT_CROSS_LOCATION_CONFLICT"
  | "PUBLISHED_SHIFT_UNCHANGED"
  | "PUBLISHED_SHIFT_POLICY_DENIED"
  | "PUBLISHED_SHIFT_KEY_REUSED";

export class EditPublishedShiftFailure extends Error {
  constructor(readonly code: EditPublishedShiftFailureCode) {
    super(code);
    this.name = "EditPublishedShiftFailure";
  }
}

export interface InternalEditPublishedShift {
  /** Must be constructed only from a verified server-side identity. */
  readonly actor: TrustedActor;
  readonly shiftId: string;
  readonly startAt: string;
  readonly endAt: string;
  /** Optimistic compare-and-swap revision; independent of draft_revision. */
  readonly expectedPublishedRevision: number;
  readonly idempotencyKey: string;
}

export interface EditedPublishedShiftReceipt {
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly previousStartAt: string;
  readonly previousEndAt: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly active: true;
  readonly publishedRevision: number;
}

/**
 * Mandatory trusted policy adapter for approval mode, entitlements and
 * publication rules. No permissive default or public API is provided.
 */
export type AssertMayEditPublishedShift = (
  client: PoolClient,
  context: {
    readonly actor: TrustedActor;
    readonly tenantId: string;
    readonly shiftId: string;
    readonly staffId: string;
    readonly locationId: string;
    readonly oldStartAt: string;
    readonly oldEndAt: string;
    readonly newStartAt: string;
    readonly newEndAt: string;
  },
) => Promise<void>;

interface ShiftRow extends QueryResultRow {
  id: string;
  staff_id: string;
  location_id: string;
  start_at: Date;
  end_at: Date;
  active: boolean;
  published_revision: number;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  result: EditedPublishedShiftReceipt;
}
interface TargetRow extends QueryResultRow {
  time_zone: string | null;
}

function reject(code: EditPublishedShiftFailureCode): never {
  throw new EditPublishedShiftFailure(code);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseMinute(value: string): string {
  if (typeof value !== "string" || !UTC_MINUTE.test(value)) {
    reject("INVALID_PUBLISHED_SHIFT_EDIT");
  }
  const ms = Date.parse(value);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    reject("INVALID_PUBLISHED_SHIFT_EDIT");
  }
  return new Date(ms).toISOString();
}

/**
 * Edit ONLY the UTC interval of an already-published, not-yet-started shift.
 * Changes to staff/location or to existing bookings are never accepted.
 *
 * StaffProfile FOR UPDATE before ShiftWindow FOR UPDATE serializes with
 * Create/Cancel/Reschedule Booking, schedule blocks, draft edits and
 * Publish/Disable Shift. This protocol must be mandatory for every writer
 * (via least-privilege database roles) before a commercial launch.
 */
export async function editPublishedShiftInternal(
  pool: Pool,
  input: InternalEditPublishedShift,
  assertMayEdit: AssertMayEditPublishedShift,
  /** Trusted composition: caller owns BEGIN/COMMIT/ROLLBACK and release. */
  transactionClient?: PoolClient,
): Promise<EditedPublishedShiftReceipt> {
  if (
    !input ||
    !input.actor ||
    !UUID.test(input.actor.tenantId) ||
    !UUID.test(input.actor.identityId) ||
    typeof input.actor.correlationId !== "string" ||
    input.actor.correlationId.length < 1 ||
    input.actor.correlationId.length > 128 ||
    !UUID.test(input.shiftId) ||
    !Number.isSafeInteger(input.expectedPublishedRevision) ||
    input.expectedPublishedRevision < 0 ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128 ||
    typeof assertMayEdit !== "function"
  ) {
    reject("INVALID_PUBLISHED_SHIFT_EDIT");
  }

  const startAt = parseMinute(input.startAt);
  const endAt = parseMinute(input.endAt);
  const duration = Date.parse(endAt) - Date.parse(startAt);
  if (duration <= 0 || duration > MAX_INTERVAL_MS) {
    reject("INVALID_PUBLISHED_SHIFT_EDIT");
  }
  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = digest(input.idempotencyKey);
  const requestHash = digest(
    JSON.stringify([
      input.shiftId,
      input.expectedPublishedRevision,
      startAt,
      endAt,
    ]),
  );
  const client = transactionClient ?? (await pool.connect());
  const ownsTransaction = transactionClient === undefined;
  let active = false;
  try {
    if (ownsTransaction) await client.query("BEGIN");
    active = true;

    // Reference is read before lock ONLY to find the stored staff. Always
    // re-read and verify under the StaffProfile and shift row locks.
    const initial = await client.query<ShiftRow>(
      `SELECT staff_id::text, location_id::text
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.shiftId],
    );
    const reference = initial.rows[0];
    if (!reference) reject("PUBLISHED_SHIFT_NOT_FOUND");

    const lock = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (lock.rowCount !== 1) reject("PUBLISHED_SHIFT_NOT_FOUND");

    const current = await client.query<ShiftRow>(
      `SELECT id::text, staff_id::text, location_id::text,
              start_at, end_at, active, published_revision
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.shiftId],
    );
    const shift = current.rows[0];
    if (
      !shift ||
      shift.staff_id !== reference.staff_id ||
      shift.location_id !== reference.location_id
    ) {
      reject("PUBLISHED_SHIFT_NOT_FOUND");
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
      [JSON.stringify([tenantId, actorId, "schedule.shift.edit", keyHash])],
    );
    const oldReceipt = await client.query<ReceiptRow>(
      `SELECT request_sha256, result
         FROM cookie_scheduling.shift_edit_receipts
        WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
          AND key_sha256=$3`,
      [tenantId, actorId, keyHash],
    );
    if (oldReceipt.rows[0]) {
      if (oldReceipt.rows[0].request_sha256 !== requestHash) {
        reject("PUBLISHED_SHIFT_KEY_REUSED");
      }
      if (ownsTransaction) await client.query("COMMIT");
      active = false;
      return oldReceipt.rows[0].result;
    }

    if (!shift.active) reject("PUBLISHED_SHIFT_NOT_EDITABLE");

    // Only a shift from the authorized F1 publication path can be edited.
    // Historical SQL-created active rows or disabled/reactivated rows fail
    // closed; no implicit legacy or admin bypass is created.
    const provenance = await client.query(
      `SELECT id FROM cookie_scheduling.shift_publish_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
        LIMIT 1`,
      [tenantId, shift.id],
    );
    const historicalDisable = await client.query(
      `SELECT id FROM cookie_scheduling.shift_disable_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
        LIMIT 1`,
      [tenantId, shift.id],
    );
    if (!provenance.rowCount || historicalDisable.rowCount) {
      reject("PUBLISHED_SHIFT_NOT_EDITABLE");
    }

    if (shift.published_revision !== input.expectedPublishedRevision) {
      reject("PUBLISHED_SHIFT_STALE_REVISION");
    }
    const oldStartAt = shift.start_at.toISOString();
    const oldEndAt = shift.end_at.toISOString();
    if (oldStartAt === startAt && oldEndAt === endAt) {
      reject("PUBLISHED_SHIFT_UNCHANGED");
    }

    const now = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const timestamp = now.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY;
    if (
      Date.parse(startAt) <= timestamp ||
      shift.start_at.getTime() <= timestamp
    ) {
      reject("PUBLISHED_SHIFT_NOT_FUTURE");
    }

    const target = await client.query<TargetRow>(
      `SELECT location.time_zone
         FROM cookie_staff.location_assignments AS assignment
         JOIN cookie_staff.staff_profiles AS staff
           ON staff.tenant_id=assignment.tenant_id
          AND staff.id=assignment.staff_id
         JOIN cookie_tenancy.locations AS location
           ON location.tenant_id=assignment.tenant_id
          AND location.id=assignment.location_id
        WHERE assignment.tenant_id=$1::uuid
          AND assignment.staff_id=$2::uuid
          AND assignment.location_id=$3::uuid
          AND assignment.active AND staff.active AND staff.bookable
        FOR SHARE OF assignment, location`,
      [tenantId, shift.staff_id, shift.location_id],
    );
    const zone = target.rows[0]?.time_zone;
    if (!zone) reject("PUBLISHED_SHIFT_TARGET_UNAVAILABLE");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    } catch {
      reject("PUBLISHED_SHIFT_TARGET_UNAVAILABLE");
    }

    try {
      await assertMayEdit(client, {
        actor: input.actor,
        tenantId,
        shiftId: shift.id,
        staffId: shift.staff_id,
        locationId: shift.location_id,
        oldStartAt,
        oldEndAt,
        newStartAt: startAt,
        newEndAt: endAt,
      });
    } catch {
      throw new EditPublishedShiftFailure("PUBLISHED_SHIFT_POLICY_DENIED");
    }

    // F1 conservative rule, shared with PublishShift: never offer active
    // overlapping availability in two branches for the same StaffProfile.
    const branchCollision = await client.query(
      `SELECT id FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
          AND location_id<>$3::uuid AND active
          AND tstzrange(start_at,end_at,'[)')
              && tstzrange($4::timestamptz,$5::timestamptz,'[)')
        LIMIT 1`,
      [tenantId, shift.staff_id, shift.location_id, startAt, endAt],
    );
    if (branchCollision.rowCount) {
      reject("PUBLISHED_SHIFT_CROSS_LOCATION_CONFLICT");
    }

    // If a future Confirmed booking intersects the OLD shift, its WHOLE
    // occupied interval (service + buffer) must remain inside either the
    // NEW interval or one other active shift at this SAME location.
    // Never silently cancel, move or shorten a visit.
    const orphaned = await client.query(
      `SELECT booking.id
         FROM cookie_booking.bookings AS booking
        WHERE booking.tenant_id=$1::uuid
          AND booking.staff_id=$2::uuid AND booking.location_id=$3::uuid
          AND booking.status='Confirmed'
          AND booking.occupied_until > clock_timestamp()
          AND tstzrange(booking.start_at, booking.occupied_until,'[)')
              && tstzrange($4::timestamptz,$5::timestamptz,'[)')
          AND NOT (
            $6::timestamptz <= booking.start_at
            AND $7::timestamptz >= booking.occupied_until
          )
          AND NOT EXISTS (
            SELECT 1 FROM cookie_scheduling.shift_windows AS alternative
             WHERE alternative.tenant_id=booking.tenant_id
               AND alternative.staff_id=booking.staff_id
               AND alternative.location_id=booking.location_id
               AND alternative.id<>$8::uuid AND alternative.active
               AND alternative.start_at<=booking.start_at
               AND alternative.end_at>=booking.occupied_until
          )
         LIMIT 1`,
      [
        tenantId,
        shift.staff_id,
        shift.location_id,
        oldStartAt,
        oldEndAt,
        startAt,
        endAt,
        shift.id,
      ],
    );
    if (orphaned.rowCount) reject("PUBLISHED_SHIFT_BOOKING_CONFLICT");

    const nextRevision = shift.published_revision + 1;
    const updated = await client.query(
      `UPDATE cookie_scheduling.shift_windows
         SET start_at=$3::timestamptz, end_at=$4::timestamptz,
             published_revision=$5
        WHERE tenant_id=$1::uuid AND id=$2::uuid
          AND active AND published_revision=$6`,
      [
        tenantId,
        shift.id,
        startAt,
        endAt,
        nextRevision,
        input.expectedPublishedRevision,
      ],
    );
    if (updated.rowCount !== 1) {
      reject("PUBLISHED_SHIFT_STALE_REVISION");
    }

    const receipt: EditedPublishedShiftReceipt = {
      shiftId: shift.id,
      staffId: shift.staff_id,
      locationId: shift.location_id,
      previousStartAt: oldStartAt,
      previousEndAt: oldEndAt,
      startAt,
      endAt,
      active: true,
      publishedRevision: nextRevision,
    };
    await client.query(
      `INSERT INTO cookie_scheduling.shift_edit_audit
         (tenant_id,id,shift_id,actor_identity_id,correlation_id,
          old_start_at,old_end_at,new_start_at,new_end_at,
          old_revision,new_revision)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,
               $6::timestamptz,$7::timestamptz,
               $8::timestamptz,$9::timestamptz,$10,$11)`,
      [
        tenantId,
        randomUUID(),
        shift.id,
        actorId,
        input.actor.correlationId,
        oldStartAt,
        oldEndAt,
        startAt,
        endAt,
        shift.published_revision,
        nextRevision,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      dedupeKey: `schedule.shift.edited:${shift.id}:${nextRevision}`,
      topic: "schedule.shift.edited",
      payload: {
        shiftId: shift.id,
        staffId: shift.staff_id,
        locationId: shift.location_id,
        oldStartAt,
        oldEndAt,
        startAt,
        endAt,
        publishedRevision: nextRevision,
      },
    });
    await client.query(
      `INSERT INTO cookie_scheduling.shift_edit_receipts
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
