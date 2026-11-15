import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import {
  readModeLocked,
  requireOwner,
  requireScopedManager,
} from "./approval.js";
import {
  disableShiftInternal,
  type AssertMayDisableShift,
  type DisabledShiftReceipt,
  type InternalDisableShift,
} from "./disable-shift.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ScheduleDisableFailureCode =
  | "SCHEDULE_DISABLE_INVALID"
  | "SCHEDULE_DISABLE_APPROVAL_REQUIRED"
  | "SCHEDULE_DISABLE_APPROVAL_NOT_ENABLED"
  | "SCHEDULE_DISABLE_REQUEST_NOT_FOUND"
  | "SCHEDULE_DISABLE_REQUEST_STALE"
  | "SCHEDULE_DISABLE_REQUEST_CONFLICT"
  | "SCHEDULE_DISABLE_ALREADY_DECIDED"
  | "SCHEDULE_DISABLE_KEY_REUSED";

export class ScheduleDisableFailure extends Error {
  constructor(readonly code: ScheduleDisableFailureCode) {
    super(code);
    this.name = "ScheduleDisableFailure";
  }
}

export interface InternalRequestDisableShift {
  readonly actor: TrustedActor;
  readonly shiftId: string;
  readonly expectedPublishedRevision: number;
  readonly idempotencyKey: string;
}

export interface InternalReviewDisableShift {
  readonly actor: TrustedActor;
  readonly requestId: string;
  readonly action: "approve" | "reject";
  readonly idempotencyKey: string;
}

export interface DisableShiftRequestReceipt {
  readonly requestId: string;
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly expectedPublishedRevision: number;
  readonly policyRevision: number;
  readonly status: "pending";
}

export type DisableShiftReviewReceipt =
  | {
      readonly requestId: string;
      readonly status: "rejected";
    }
  | {
      readonly requestId: string;
      readonly status: "applied";
      readonly disabledShift: DisabledShiftReceipt;
    };

interface ShiftRow extends QueryResultRow {
  id: string;
  staff_id: string;
  location_id: string;
  active: boolean;
  published_revision: number;
  start_at: Date;
  end_at: Date;
}
interface RequestRow extends QueryResultRow {
  id: string;
  shift_id: string;
  staff_id: string;
  location_id: string;
  requester_identity_id: string;
  request_sha256: string;
  policy_revision: number;
  expected_published_revision: number;
  expected_start_at: Date;
  expected_end_at: Date;
  status: "pending" | "applied" | "rejected";
  reviewer_identity_id: string | null;
  decision_key_sha256: string | null;
  applied_receipt: DisabledShiftReceipt | null;
}

function fail(code: ScheduleDisableFailureCode): never {
  throw new ScheduleDisableFailure(code);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validKey(key: string): boolean {
  return typeof key === "string" && key.length > 0 && key.length <= 128;
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < 2147483647;
}

function assertActor(actor: TrustedActor): void {
  if (
    !actor ||
    !UUID.test(actor.identityId) ||
    !UUID.test(actor.tenantId) ||
    typeof actor.correlationId !== "string" ||
    actor.correlationId.length === 0 ||
    actor.correlationId.length > 128
  ) {
    fail("SCHEDULE_DISABLE_INVALID");
  }
}

/**
 * IMPORTANT: this is the ONLY future operator-facing direct-disable adapter.
 * It reuses the existing booking-safe command and checks the organization
 * policy inside the same transaction as the shift disable.
 *
 * The lower-level disableShiftInternal remains an internal trusted primitive.
 */
export async function disableShiftDirectInternal(
  pool: Pool,
  input: InternalDisableShift,
  assertMayDisable: AssertMayDisableShift,
): Promise<DisabledShiftReceipt> {
  assertActor(input?.actor);
  if (typeof assertMayDisable !== "function") {
    fail("SCHEDULE_DISABLE_INVALID");
  }
  return disableShiftInternal(pool, input, async (client, context) => {
    const policy = await readModeLocked(client, context.tenantId);
    if (policy.mode !== "direct") {
      fail("SCHEDULE_DISABLE_APPROVAL_REQUIRED");
    }
    await assertMayDisable(client, context);
  });
}

/**
 * Request is inert: no shift mutation or held booking slot.
 * Scope, publication provenance, original window and policy revision are
 * stored so approval cannot unknowingly execute an obsolete command.
 */
export async function requestDisableShiftInternal(
  pool: Pool,
  input: InternalRequestDisableShift,
): Promise<DisableShiftRequestReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.shiftId) ||
    !validRevision(input.expectedPublishedRevision) ||
    !validKey(input.idempotencyKey)
  ) {
    fail("SCHEDULE_DISABLE_INVALID");
  }

  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = digest(input.idempotencyKey);
  const requestHash = digest(
    JSON.stringify([input.shiftId, input.expectedPublishedRevision]),
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const initial = await client.query<ShiftRow>(
      `SELECT staff_id::text,location_id::text
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.shiftId],
    );
    const reference = initial.rows[0];
    if (!reference) fail("SCHEDULE_DISABLE_REQUEST_NOT_FOUND");

    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (!staff.rowCount) fail("SCHEDULE_DISABLE_REQUEST_NOT_FOUND");

    const current = await client.query<ShiftRow>(
      `SELECT id::text,staff_id::text,location_id::text,active,
              published_revision,start_at,end_at
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
      fail("SCHEDULE_DISABLE_REQUEST_NOT_FOUND");
    }

    await requireScopedManager(
      client,
      input.actor,
      shift.staff_id,
      shift.location_id,
    );
    const policy = await readModeLocked(client, tenantId);
    if (policy.mode !== "approval") {
      fail("SCHEDULE_DISABLE_APPROVAL_NOT_ENABLED");
    }

    const previous = await client.query<RequestRow>(
      `SELECT id::text,shift_id::text,staff_id::text,location_id::text,
              request_sha256,policy_revision,expected_published_revision
         FROM cookie_scheduling.schedule_disable_requests
        WHERE tenant_id=$1::uuid AND requester_identity_id=$2::uuid
          AND key_sha256=$3`,
      [tenantId, actorId, keyHash],
    );
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (old.request_sha256 !== requestHash) {
        fail("SCHEDULE_DISABLE_KEY_REUSED");
      }
      await client.query("COMMIT");
      return {
        requestId: old.id,
        shiftId: old.shift_id,
        staffId: old.staff_id,
        locationId: old.location_id,
        expectedPublishedRevision: old.expected_published_revision,
        policyRevision: old.policy_revision,
        status: "pending",
      };
    }

    const now = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    if (
      !shift.active ||
      shift.published_revision !== input.expectedPublishedRevision ||
      shift.start_at.getTime() <=
        (now.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY)
    ) {
      fail("SCHEDULE_DISABLE_REQUEST_STALE");
    }
    const publication = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_publish_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid LIMIT 1`,
      [tenantId, shift.id],
    );
    const disabled = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_disable_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid LIMIT 1`,
      [tenantId, shift.id],
    );
    if (!publication.rowCount || disabled.rowCount) {
      fail("SCHEDULE_DISABLE_REQUEST_STALE");
    }

    const requestId = randomUUID();
    await client.query(
      `INSERT INTO cookie_scheduling.schedule_disable_requests
         (tenant_id,id,shift_id,staff_id,location_id,
          requester_identity_id,key_sha256,request_sha256,policy_revision,
          expected_published_revision,expected_start_at,expected_end_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,
               $7,$8,$9,$10,$11::timestamptz,$12::timestamptz)`,
      [
        tenantId,
        requestId,
        shift.id,
        shift.staff_id,
        shift.location_id,
        actorId,
        keyHash,
        requestHash,
        policy.revision,
        input.expectedPublishedRevision,
        shift.start_at,
        shift.end_at,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.disable.requested",
      dedupeKey: `schedule.disable.requested:${requestId}`,
      payload: {
        requestId,
        shiftId: shift.id,
        locationId: shift.location_id,
      },
    });
    await client.query("COMMIT");
    return {
      requestId,
      shiftId: shift.id,
      staffId: shift.staff_id,
      locationId: shift.location_id,
      expectedPublishedRevision: input.expectedPublishedRevision,
      policyRevision: policy.revision,
      status: "pending",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Approve rechecks real owner + requester's LIVE role and shift snapshot.
 * DisableShift's booking-coverage proof and every side effect commit in the
 * SAME transaction as the terminal request decision. A failure leaves the
 * request pending and the shift active.
 */
export async function reviewDisableShiftInternal(
  pool: Pool,
  input: InternalReviewDisableShift,
  assertMayDisable: AssertMayDisableShift,
): Promise<DisableShiftReviewReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.requestId) ||
    (input.action !== "approve" && input.action !== "reject") ||
    !validKey(input.idempotencyKey) ||
    typeof assertMayDisable !== "function"
  ) {
    fail("SCHEDULE_DISABLE_INVALID");
  }
  const tenantId = input.actor.tenantId;
  const reviewer = input.actor.identityId;
  const decisionHash = digest(input.idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const initial = await client.query<RequestRow>(
      `SELECT shift_id::text,staff_id::text,location_id::text
         FROM cookie_scheduling.schedule_disable_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.requestId],
    );
    const reference = initial.rows[0];
    if (!reference) fail("SCHEDULE_DISABLE_REQUEST_NOT_FOUND");

    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (!staff.rowCount) fail("SCHEDULE_DISABLE_REQUEST_NOT_FOUND");

    const current = await client.query<RequestRow>(
      `SELECT id::text,shift_id::text,staff_id::text,location_id::text,
              requester_identity_id::text,request_sha256,policy_revision,
              expected_published_revision,expected_start_at,expected_end_at,
              status,reviewer_identity_id::text,decision_key_sha256,applied_receipt
         FROM cookie_scheduling.schedule_disable_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.requestId],
    );
    const request = current.rows[0];
    if (
      !request ||
      request.shift_id !== reference.shift_id ||
      request.staff_id !== reference.staff_id ||
      request.location_id !== reference.location_id
    ) {
      fail("SCHEDULE_DISABLE_REQUEST_NOT_FOUND");
    }

    await requireOwner(client, input.actor);
    await requireScopedManager(
      client,
      input.actor,
      request.staff_id,
      request.location_id,
    );

    if (request.status !== "pending") {
      const desired = input.action === "approve" ? "applied" : "rejected";
      if (
        request.status !== desired ||
        request.reviewer_identity_id !== reviewer ||
        request.decision_key_sha256 !== decisionHash
      ) {
        fail("SCHEDULE_DISABLE_ALREADY_DECIDED");
      }
      await client.query("COMMIT");
      return request.status === "applied"
        ? {
            requestId: request.id,
            status: "applied",
            disabledShift: request.applied_receipt!,
          }
        : { requestId: request.id, status: "rejected" };
    }

    // Explicit rejection is a terminal request decision, even if policy has
    // changed. It never affects booking or published shift state.
    if (input.action === "reject") {
      await client.query(
        `UPDATE cookie_scheduling.schedule_disable_requests
           SET status='rejected',reviewer_identity_id=$3::uuid,
               decision_key_sha256=$4,decided_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
        [tenantId, request.id, reviewer, decisionHash],
      );
      await enqueueOutbox(client, {
        tenantId,
        topic: "schedule.disable.rejected",
        dedupeKey: `schedule.disable.rejected:${request.id}`,
        payload: { requestId: request.id, shiftId: request.shift_id },
      });
      await client.query("COMMIT");
      return { requestId: request.id, status: "rejected" };
    }

    const policy = await readModeLocked(client, tenantId);
    if (
      policy.mode !== "approval" ||
      policy.revision !== request.policy_revision
    ) {
      fail("SCHEDULE_DISABLE_REQUEST_STALE");
    }

    const requester: TrustedActor = {
      tenantId,
      identityId: request.requester_identity_id,
      correlationId: input.actor.correlationId,
    };
    await requireScopedManager(
      client,
      requester,
      request.staff_id,
      request.location_id,
    );

    const lockedShift = await client.query<ShiftRow>(
      `SELECT id::text,staff_id::text,location_id::text,active,
              published_revision,start_at,end_at
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, request.shift_id],
    );
    const shift = lockedShift.rows[0];
    if (
      !shift ||
      !shift.active ||
      shift.staff_id !== request.staff_id ||
      shift.location_id !== request.location_id ||
      shift.published_revision !== request.expected_published_revision ||
      shift.start_at.getTime() !== request.expected_start_at.getTime() ||
      shift.end_at.getTime() !== request.expected_end_at.getTime()
    ) {
      fail("SCHEDULE_DISABLE_REQUEST_STALE");
    }

    const disabled = await disableShiftInternal(
      pool,
      {
        actor: input.actor,
        shiftId: request.shift_id,
        idempotencyKey: `disable-approval:${request.id}`,
      },
      async (transaction, context) => {
        const currentPolicy = await readModeLocked(transaction, tenantId);
        if (
          currentPolicy.mode !== "approval" ||
          currentPolicy.revision !== request.policy_revision
        ) {
          fail("SCHEDULE_DISABLE_REQUEST_STALE");
        }
        await assertMayDisable(transaction, context);
      },
      client,
    );

    await client.query(
      `UPDATE cookie_scheduling.schedule_disable_requests
         SET status='applied',reviewer_identity_id=$3::uuid,
             decision_key_sha256=$4,applied_receipt=$5::jsonb,
             decided_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
      [
        tenantId,
        request.id,
        reviewer,
        decisionHash,
        JSON.stringify(disabled),
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.disable.applied",
      dedupeKey: `schedule.disable.applied:${request.id}`,
      payload: { requestId: request.id, shiftId: request.shift_id },
    });
    await client.query("COMMIT");
    return { requestId: request.id, status: "applied", disabledShift: disabled };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
