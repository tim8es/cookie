import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  enqueueOutbox,
  runSqlTransaction,
} from "../../platform-db/src/index.js";
import type { TrustedActor } from "../../platform-identity/src/index.js";
import {
  requireTenantPermission,
  AuthorizationDeniedError,
} from "../../platform-identity/src/index.js";
import { readStagingCustomerContext } from "../../domain-customers/src/index.js";

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

export interface CancelledBookingReceipt<
  Status extends
    | "CancelledByBusiness"
    | "CancelledByClient" = "CancelledByBusiness",
> {
  readonly bookingId: string;
  readonly status: Status;
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
  result: CancelledBookingReceipt<"CancelledByBusiness" | "CancelledByClient">;
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
  return cancelBooking(pool, input, "CancelledByBusiness", assertMayCancel);
}

/** No default or public policy. An explicit controlled-staging cutoff is
 * required; a new booking entitlement is deliberately not required. */
export async function cancelStagingCustomerBooking(
  pool: Pool,
  input: InternalCancelBooking,
  cutoffMinutes: number,
): Promise<CancelledBookingReceipt<"CancelledByClient">> {
  if (
    !Number.isSafeInteger(cutoffMinutes) ||
    cutoffMinutes < 0 ||
    cutoffMinutes > 525600
  )
    invalid();
  if (!input.actor.opaqueSessionAuthority) throw new AuthorizationDeniedError();
  return cancelBooking(
    pool,
    input,
    "CancelledByClient",
    async (client, booking) => {
      const allowed = await client.query(
        "SELECT 1 WHERE $1::timestamptz > clock_timestamp() + $2::int * interval '1 minute'",
        [booking.startAt, cutoffMinutes],
      );
      if (allowed.rowCount !== 1)
        throw new CancelBookingFailure("CANCELLATION_POLICY_DENIED");
    },
    cutoffMinutes,
  );
}

/** Synthetic operator-controlled staging only. This does not define a
 * salon-owned cancellation policy (#285), nor grant access by itself: the
 * trusted callback must establish current owner and exact branch inside
 * the command transaction. The UPDATE rechecks the explicit cutoff. */
export async function cancelStagingOwnerBooking(
  pool: Pool,
  input: InternalCancelBooking,
  cutoffMinutes: number,
  assertMayCancel: AssertBookingMayCancel,
): Promise<CancelledBookingReceipt<"CancelledByBusiness">> {
  if (
    !Number.isSafeInteger(cutoffMinutes) ||
    cutoffMinutes < 0 ||
    cutoffMinutes > 525600 ||
    typeof assertMayCancel !== "function"
  )
    invalid();
  if (!input?.actor?.opaqueSessionAuthority)
    throw new AuthorizationDeniedError();
  return cancelBooking(
    pool,
    input,
    "CancelledByBusiness",
    assertMayCancel,
    cutoffMinutes,
  );
}

async function cancelBooking<
  Status extends "CancelledByBusiness" | "CancelledByClient",
>(
  pool: Pool,
  input: InternalCancelBooking,
  status: Status,
  assertMayCancel: AssertBookingMayCancel,
  cutoffMinutes?: number,
): Promise<CancelledBookingReceipt<Status>> {
  validate(input);
  const staging = status === "CancelledByClient";

  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = sha256(input.idempotencyKey);
  const requestHash = sha256(
    JSON.stringify(staging ? [input.bookingId, status] : [input.bookingId]),
  );
  return runSqlTransaction(pool, async (client) => {
    // Read only immutable Staff/Location reference for deterministic lock
    // order. Never trust a staff or location value passed by a caller.
    const reference = await client.query<BookingRow>(
      `SELECT staff_id::text, location_id::text
         FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND id=$2::uuid
          AND (NOT $3::boolean OR EXISTS (
            SELECT 1 FROM cookie_customers.staging_customer_identities c
            WHERE c.tenant_id=bookings.tenant_id AND c.customer_id=bookings.customer_id
              AND c.identity_id=$4::uuid
          ))`,
      [tenantId, input.bookingId, staging, actorId],
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

    if (staging) {
      const context = await readStagingCustomerContext(client, input.actor);
      if (context.customerId !== current.customer_id)
        throw new CancelBookingFailure("BOOKING_NOT_FOUND");
      await requireTenantPermission(
        client,
        input.actor,
        { kind: "customer-self", tenantId, clientIdentityId: actorId },
        "staging.customer.booking.cancel",
      );
    } else {
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
    }

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
      const receipt = previous.rows[0].result;
      if (receipt.status !== status)
        throw new CancelBookingFailure("IDEMPOTENCY_KEY_REUSED");
      return { ...receipt, status };
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
          SET status=$3::text, cancelled_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='Confirmed'
          AND ($4::int IS NULL OR start_at > clock_timestamp() + $4::int * interval '1 minute')
        RETURNING cancelled_at`,
      [tenantId, input.bookingId, status, cutoffMinutes ?? null],
    );
    const cancelled = updated.rows[0];
    if (!cancelled) {
      throw new CancelBookingFailure(
        cutoffMinutes !== undefined
          ? "CANCELLATION_POLICY_DENIED"
          : "BOOKING_NOT_CONFIRMED",
      );
    }
    const receipt: CancelledBookingReceipt<Status> = {
      bookingId: input.bookingId,
      status,
      cancelledAt: cancelled.cancelled_at.toISOString(),
    };
    await client.query(
      `INSERT INTO cookie_booking.booking_state_audit
         (id, tenant_id, booking_id, actor_identity_id, correlation_id,
          command, previous_status, next_status)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,
               'booking.cancel','Confirmed',$6::text)`,
      [
        randomUUID(),
        tenantId,
        input.bookingId,
        actorId,
        input.actor.correlationId,
        status,
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

    if (staging) {
      const context = await readStagingCustomerContext(client, input.actor);
      if (context.customerId !== current.customer_id)
        throw new AuthorizationDeniedError();
    }
    return receipt;
  });
}
