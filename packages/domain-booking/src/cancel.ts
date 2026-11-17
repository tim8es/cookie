import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { enqueueOutbox, runSqlTransaction } from "../../platform-db/src/index.js";
import type { TrustedActor } from "../../platform-identity/src/index.js";
import { requireTenantPermission } from "../../platform-identity/src/index.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CancelBookingFailureCode =
  | "INVALID_CANCELLATION_COMMAND"
  | "BOOKING_NOT_FOUND"
  | "BOOKING_NOT_CONFIRMED"
  | "CANCELLATION_POLICY_DENIED"
  | "IDEMPOTENCY_KEY_REUSED";

export class CancelBookingFailure extends Error {
  constructor(readonly code: CancelBookingFailureCode) {
    super(code);
    this.name = "CancelBookingFailure";
  }
}

export interface InternalCancelBooking {
  /** Only created from a verified server-side session, never from JSON. */
  readonly actor: TrustedActor;
  readonly bookingId: string;
  readonly idempotencyKey: string;
}

export interface CancelledBookingReceipt {
  readonly bookingId: string;
  readonly status: "CancelledByBusiness";
  readonly cancelledAt: string;
}

/**
 * A real cancellation cutoff and exception policy is not implemented yet.
 * The server MUST supply a trusted policy callback and enforce any agreed
 * deadline/exceptions inside the command transaction (no network calls).
 */
export type AssertBookingMayCancel = (
  client: PoolClient,
  booking: {
    readonly tenantId: string;
    readonly bookingId: string;
    readonly locationId: string;
    readonly staffId: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly customerId: string;
  },
) => Promise<void>;

interface BookingRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  location_id: string;
  staff_id: string;
  status: string;
  start_at: Date;
  end_at: Date;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  result: CancelledBookingReceipt;
}
interface CancelResult extends QueryResultRow {
  cancelled_at: Date;
}

function invalid(): never {
  throw new CancelBookingFailure("INVALID_CANCELLATION_COMMAND");
}

function validate(input: InternalCancelBooking): void {
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
    input.idempotencyKey.length > 128
  ) {
    invalid();
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * F1 **business-side** cancellation only. Client self-service is impossible
 * until a trusted CustomerâIdentity relation exists. This shares the Staff
 * row lock used by CreateBooking so cancelling and rebooking do not race.
 *
 * One transaction commits: state change, mutation audit, notification Outbox
 * and operation receipt. If anything fails, the old Confirmed remains intact.
 */
export async function cancelBookingInternal(
  pool: Pool,
  input: InternalCancelBooking,
  assertMayCancel: AssertBookingMayCancel,
): Promise<CancelledBookingReceipt> {
  if (typeof assertMayCancel !== "function") invalid();
  validate(input);

  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = sha256(input.idempotencyKey);
  const requestHash = sha256(JSON.stringify([input.bookingId]));
  return runSqlTransaction(pool, async (client) => {
    // Read only immutable Staff/Location reference for deterministic lock
    // order. Never trust a staff or location value passed by a caller.
    const reference = await client.query<BookingRow>(
      `SELECT staff_id::text, location_id::text
         FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.bookingId],
    );
    const preliminary = reference.rows[0];
    if (!preliminary) throw new CancelBookingFailure("BOOKING_NOT_FOUND");

    const staffLock = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, preliminary.staff_id],
    );
    if (staffLock.rowCount !== 1) {
      throw new CancelBookingFailure("BOOKING_NOT_FOUND");
    }

    const currentResult = await client.query<BookingRow>(
      `SELECT id::text, tenant_id::text, customer_id::text,
              location_id::text, staff_id::text, status, start_at, end_at
         FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.bookingId],
    );
    const current = currentResult.rows[0];
    if (
      !current ||
      current.staff_id !== preliminary.staff_id ||
      current.location_id !== preliminary.location_id
    ) {
      throw new CancelBookingFailure("BOOKING_NOT_FOUND");
    }

    await requireTenantPermission(
      client,
      input.actor,
      {
        kind: "booking",
        tenantId,
        locationId: current.location_id,
        staffProfileId: current.staff_id,
      },
      "booking.cancel",
    );

    // Match CreateBooking's scoped advisory lock protocol. A duplicate key
    // must yield the original committed response after authorization checks.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [JSON.stringify([tenantId, actorId, "booking.cancel", keyHash])],
    );
    const previous = await client.query<ReceiptRow>(
      `SELECT request_sha256, result
         FROM cookie_booking.command_receipts
        WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
          AND operation='booking.cancel' AND key_sha256=$3`,
      [tenantId, actorId, keyHash],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_sha256 !== requestHash) {
        throw new CancelBookingFailure("IDEMPOTENCY_KEY_REUSED");
      }
      return previous.rows[0].result;
    }
    if (current.status !== "Confirmed") {
      throw new CancelBookingFailure("BOOKING_NOT_CONFIRMED");
    }

    try {
      await assertMayCancel(client, {
        tenantId,
        bookingId: input.bookingId,
        staffId: current.staff_id,
        locationId: current.location_id,
        startAt: current.start_at.toISOString(),
        endAt: current.end_at.toISOString(),
        customerId: current.customer_id,
      });
    } catch {
      // Never expose policy-adapter internals to an eventual API.
      throw new CancelBookingFailure("CANCELLATION_POLICY_DENIED");
    }

    const updated = await client.query<CancelResult>(
      `UPDATE cookie_booking.bookings
          SET status='CancelledByBusiness', cancelled_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='Confirmed'
        RETURNING cancelled_at`,
      [tenantId, input.bookingId],
    );
    const cancelled = updated.rows[0];
    if (!cancelled) {
      throw new CancelBookingFailure("BOOKING_NOT_CONFIRMED");
    }
    const receipt: CancelledBookingReceipt = {
      bookingId: input.bookingId,
      status: "CancelledByBusiness",
      cancelledAt: cancelled.cancelled_at.toISOString(),
    };
    await client.query(
      `INSERT INTO cookie_booking.booking_state_audit
         (id, tenant_id, booking_id, actor_identity_id, correlation_id,
          command, previous_status, next_status)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,
               'booking.cancel','Confirmed','CancelledByBusiness')`,
      [
        randomUUID(),
        tenantId,
        input.bookingId,
        actorId,
        input.actor.correlationId,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      dedupeKey: `booking.cancelled:${input.bookingId}`,
      topic: "booking.cancelled",
      payload: {
        bookingId: input.bookingId,
        locationId: current.location_id,
        staffId: current.staff_id,
      },
    });
    await client.query(
      `INSERT INTO cookie_booking.command_receipts
         (tenant_id,actor_identity_id,operation,key_sha256,request_sha256,
          booking_id,result)
       VALUES ($1::uuid,$2::uuid,'booking.cancel',$3,$4,$5::uuid,$6::jsonb)`,
      [
        tenantId,
        actorId,
        keyHash,
        requestHash,
        input.bookingId,
        JSON.stringify(receipt),
      ],
    );

    return receipt;
  });
}
