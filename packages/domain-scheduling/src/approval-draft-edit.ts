import { createHash, randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import {
  readModeLocked,
  requireOwner,
  requireScopedManager,
} from "./approval.js";
import {
  editShiftDraftInternal,
  type AssertMayChangeDraft,
  type InternalEditShiftDraft,
  type ShiftDraftReceipt,
} from "./draft-shift.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

export type DraftEditApprovalFailureCode =
  | "DRAFT_EDIT_APPROVAL_INVALID"
  | "DRAFT_EDIT_APPROVAL_REQUIRED"
  | "DRAFT_EDIT_APPROVAL_NOT_ENABLED"
  | "DRAFT_EDIT_APPROVAL_NOT_FOUND"
  | "DRAFT_EDIT_APPROVAL_STALE"
  | "DRAFT_EDIT_APPROVAL_UNCHANGED"
  | "DRAFT_EDIT_APPROVAL_ALREADY_DECIDED"
  | "DRAFT_EDIT_APPROVAL_KEY_REUSED";

export class DraftEditApprovalFailure extends Error {
  constructor(readonly code: DraftEditApprovalFailureCode) {
    super(code);
    this.name = "DraftEditApprovalFailure";
  }
}

export interface InternalRequestDraftEdit {
  readonly actor: TrustedActor;
  readonly shiftId: string;
  readonly expectedRevision: number;
  readonly startAt: string;
  readonly endAt: string;
  readonly idempotencyKey: string;
}
export interface InternalReviewDraftEdit {
  readonly actor: TrustedActor;
  readonly requestId: string;
  readonly action: "approve" | "reject";
  readonly idempotencyKey: string;
}
export interface DraftEditRequestReceipt {
  readonly requestId: string;
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly expectedRevision: number;
  readonly startAt: string;
  readonly endAt: string;
  readonly policyRevision: number;
  readonly status: "pending";
}
export type DraftEditReviewReceipt =
  | { readonly requestId: string; readonly status: "rejected" }
  | {
      readonly requestId: string;
      readonly status: "applied";
      readonly editedDraft: ShiftDraftReceipt;
    };

interface ShiftRow extends QueryResultRow {
  id: string;
  staff_id: string;
  location_id: string;
  active: boolean;
  draft_revision: number;
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
  expected_draft_revision: number;
  expected_start_at: Date;
  expected_end_at: Date;
  new_start_at: Date;
  new_end_at: Date;
  status: "pending" | "applied" | "rejected";
  reviewer_identity_id: string | null;
  decision_key_sha256: string | null;
  applied_receipt: ShiftDraftReceipt | null;
}

function fail(code: DraftEditApprovalFailureCode): never {
  throw new DraftEditApprovalFailure(code);
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function validKey(value: string): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}
function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < 2147483647;
}
function assertActor(actor: TrustedActor): void {
  if (
    !actor ||
    !UUID.test(actor.tenantId) ||
    !UUID.test(actor.identityId) ||
    typeof actor.correlationId !== "string" ||
    actor.correlationId.length < 1 ||
    actor.correlationId.length > 128
  ) {
    fail("DRAFT_EDIT_APPROVAL_INVALID");
  }
}
function parseMinute(value: string): string {
  if (typeof value !== "string" || !UTC_MINUTE.test(value)) {
    fail("DRAFT_EDIT_APPROVAL_INVALID");
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    fail("DRAFT_EDIT_APPROVAL_INVALID");
  }
  return new Date(parsed).toISOString();
}
function parseRange(input: InternalRequestDraftEdit): {
  startAt: string;
  endAt: string;
} {
  const startAt = parseMinute(input.startAt);
  const endAt = parseMinute(input.endAt);
  const duration = Date.parse(endAt) - Date.parse(startAt);
  if (duration <= 0 || duration > 48 * 60 * 60 * 1000) {
    fail("DRAFT_EDIT_APPROVAL_INVALID");
  }
  return { startAt, endAt };
}

/** Prospective direct adapter; underlying draft edit is trusted-only. */
export async function editShiftDraftDirectInternal(
  pool: Pool,
  input: InternalEditShiftDraft,
  assertMayChange: AssertMayChangeDraft,
): Promise<ShiftDraftReceipt> {
  assertActor(input?.actor);
  if (typeof assertMayChange !== "function") {
    fail("DRAFT_EDIT_APPROVAL_INVALID");
  }
  return editShiftDraftInternal(pool, input, async (client, context) => {
    const policy = await readModeLocked(client, input.actor.tenantId);
    if (policy.mode !== "direct") {
      fail("DRAFT_EDIT_APPROVAL_REQUIRED");
    }
    await assertMayChange(client, context);
  });
}

/**
 * An approval-mode draft edit request never mutates the draft.
 * The proposed range and current revision are immutable in the request.
 */
export async function requestShiftDraftEditInternal(
  pool: Pool,
  input: InternalRequestDraftEdit,
): Promise<DraftEditRequestReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.shiftId) ||
    !validRevision(input.expectedRevision) ||
    !validKey(input.idempotencyKey)
  ) {
    fail("DRAFT_EDIT_APPROVAL_INVALID");
  }
  const { startAt, endAt } = parseRange(input);
  const tenantId = input.actor.tenantId;
  const requesterId = input.actor.identityId;
  const keyHash = digest(input.idempotencyKey);
  const requestHash = digest(
    JSON.stringify([input.shiftId, input.expectedRevision, startAt, endAt]),
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
    const ref = initial.rows[0];
    if (!ref) fail("DRAFT_EDIT_APPROVAL_NOT_FOUND");
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, ref.staff_id],
    );
    if (!staff.rowCount) fail("DRAFT_EDIT_APPROVAL_NOT_FOUND");
    const result = await client.query<ShiftRow>(
      `SELECT id::text,staff_id::text,location_id::text,active,
              draft_revision,start_at,end_at
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.shiftId],
    );
    const shift = result.rows[0];
    if (
      !shift ||
      shift.staff_id !== ref.staff_id ||
      shift.location_id !== ref.location_id
    ) {
      fail("DRAFT_EDIT_APPROVAL_NOT_FOUND");
    }
    await requireScopedManager(
      client,
      input.actor,
      shift.staff_id,
      shift.location_id,
    );
    const mode = await readModeLocked(client, tenantId);
    if (mode.mode !== "approval") {
      fail("DRAFT_EDIT_APPROVAL_NOT_ENABLED");
    }
    const previous = await client.query<RequestRow>(
      `SELECT id::text,shift_id::text,staff_id::text,location_id::text,
              request_sha256,policy_revision,expected_draft_revision,
              new_start_at,new_end_at
         FROM cookie_scheduling.schedule_draft_edit_requests
        WHERE tenant_id=$1::uuid AND requester_identity_id=$2::uuid
          AND key_sha256=$3`,
      [tenantId, requesterId, keyHash],
    );
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (old.request_sha256 !== requestHash) {
        fail("DRAFT_EDIT_APPROVAL_KEY_REUSED");
      }
      await client.query("COMMIT");
      return {
        requestId: old.id,
        shiftId: old.shift_id,
        staffId: old.staff_id,
        locationId: old.location_id,
        expectedRevision: old.expected_draft_revision,
        startAt: old.new_start_at.toISOString(),
        endAt: old.new_end_at.toISOString(),
        policyRevision: old.policy_revision,
        status: "pending",
      };
    }
    const now = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const timeNow = now.rows[0]?.now.getTime() ?? Infinity;
    if (
      shift.active ||
      shift.draft_revision !== input.expectedRevision ||
      shift.start_at.getTime() <= timeNow ||
      Date.parse(startAt) <= timeNow
    ) {
      fail("DRAFT_EDIT_APPROVAL_STALE");
    }
    if (
      shift.start_at.toISOString() === startAt &&
      shift.end_at.toISOString() === endAt
    ) {
      fail("DRAFT_EDIT_APPROVAL_UNCHANGED");
    }
    const created = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_draft_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
          AND operation='create' LIMIT 1`,
      [tenantId, shift.id],
    );
    const published = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_publish_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid LIMIT 1`,
      [tenantId, shift.id],
    );
    const disabled = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_disable_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid LIMIT 1`,
      [tenantId, shift.id],
    );
    if (!created.rowCount || published.rowCount || disabled.rowCount) {
      fail("DRAFT_EDIT_APPROVAL_STALE");
    }
    const requestId = randomUUID();
    await client.query(
      `INSERT INTO cookie_scheduling.schedule_draft_edit_requests
         (tenant_id,id,shift_id,staff_id,location_id,requester_identity_id,
          key_sha256,request_sha256,policy_revision,expected_draft_revision,
          expected_start_at,expected_end_at,new_start_at,new_end_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,
               $7,$8,$9,$10,$11::timestamptz,$12::timestamptz,
               $13::timestamptz,$14::timestamptz)`,
      [
        tenantId,
        requestId,
        shift.id,
        shift.staff_id,
        shift.location_id,
        requesterId,
        keyHash,
        requestHash,
        mode.revision,
        input.expectedRevision,
        shift.start_at,
        shift.end_at,
        startAt,
        endAt,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.draft.edit.requested",
      dedupeKey: `schedule.draft.edit.requested:${requestId}`,
      payload: { requestId, shiftId: shift.id, locationId: shift.location_id },
    });
    await client.query("COMMIT");
    return {
      requestId,
      shiftId: shift.id,
      staffId: shift.staff_id,
      locationId: shift.location_id,
      expectedRevision: input.expectedRevision,
      startAt,
      endAt,
      policyRevision: mode.revision,
      status: "pending",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Owner review: request decision and draft mutation share ONE transaction. */
export async function reviewShiftDraftEditInternal(
  pool: Pool,
  input: InternalReviewDraftEdit,
  assertMayChange: AssertMayChangeDraft,
): Promise<DraftEditReviewReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.requestId) ||
    (input.action !== "approve" && input.action !== "reject") ||
    !validKey(input.idempotencyKey) ||
    typeof assertMayChange !== "function"
  ) {
    fail("DRAFT_EDIT_APPROVAL_INVALID");
  }
  const tenantId = input.actor.tenantId;
  const reviewer = input.actor.identityId;
  const decisionHash = digest(input.idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const initial = await client.query<RequestRow>(
      `SELECT staff_id::text,location_id::text,shift_id::text
         FROM cookie_scheduling.schedule_draft_edit_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.requestId],
    );
    const ref = initial.rows[0];
    if (!ref) fail("DRAFT_EDIT_APPROVAL_NOT_FOUND");
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, ref.staff_id],
    );
    if (!staff.rowCount) fail("DRAFT_EDIT_APPROVAL_NOT_FOUND");
    const current = await client.query<RequestRow>(
      `SELECT id::text,shift_id::text,staff_id::text,location_id::text,
              requester_identity_id::text,request_sha256,policy_revision,
              expected_draft_revision,expected_start_at,expected_end_at,
              new_start_at,new_end_at,status,reviewer_identity_id::text,
              decision_key_sha256,applied_receipt
         FROM cookie_scheduling.schedule_draft_edit_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.requestId],
    );
    const request = current.rows[0];
    if (
      !request ||
      request.shift_id !== ref.shift_id ||
      request.staff_id !== ref.staff_id ||
      request.location_id !== ref.location_id
    ) {
      fail("DRAFT_EDIT_APPROVAL_NOT_FOUND");
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
        fail("DRAFT_EDIT_APPROVAL_ALREADY_DECIDED");
      }
      await client.query("COMMIT");
      return request.status === "applied"
        ? {
            requestId: request.id,
            status: "applied",
            editedDraft: request.applied_receipt!,
          }
        : { requestId: request.id, status: "rejected" };
    }

    // A stale request may be explicitly rejected; no draft changes.
    if (input.action === "reject") {
      await client.query(
        `UPDATE cookie_scheduling.schedule_draft_edit_requests
           SET status='rejected',reviewer_identity_id=$3::uuid,
               decision_key_sha256=$4,decided_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
        [tenantId, request.id, reviewer, decisionHash],
      );
      await enqueueOutbox(client, {
        tenantId,
        topic: "schedule.draft.edit.rejected",
        dedupeKey: `schedule.draft.edit.rejected:${request.id}`,
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
      fail("DRAFT_EDIT_APPROVAL_STALE");
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
    const shiftResult = await client.query<ShiftRow>(
      `SELECT id::text,staff_id::text,location_id::text,active,
              draft_revision,start_at,end_at
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, request.shift_id],
    );
    const shift = shiftResult.rows[0];
    if (
      !shift ||
      shift.active ||
      shift.staff_id !== request.staff_id ||
      shift.location_id !== request.location_id ||
      shift.draft_revision !== request.expected_draft_revision ||
      shift.start_at.getTime() !== request.expected_start_at.getTime() ||
      shift.end_at.getTime() !== request.expected_end_at.getTime()
    ) {
      fail("DRAFT_EDIT_APPROVAL_STALE");
    }

    const changed = await editShiftDraftInternal(
      pool,
      {
        actor: input.actor,
        shiftId: request.shift_id,
        expectedRevision: request.expected_draft_revision,
        startAt: request.new_start_at.toISOString().replace(".000Z", "Z"),
        endAt: request.new_end_at.toISOString().replace(".000Z", "Z"),
        idempotencyKey: `draft-edit-approval:${request.id}`,
      },
      async (transaction, context) => {
        const currentPolicy = await readModeLocked(transaction, tenantId);
        if (
          currentPolicy.mode !== "approval" ||
          currentPolicy.revision !== request.policy_revision
        ) {
          fail("DRAFT_EDIT_APPROVAL_STALE");
        }
        await assertMayChange(transaction, context);
      },
      client,
    );
    await client.query(
      `UPDATE cookie_scheduling.schedule_draft_edit_requests
         SET status='applied',reviewer_identity_id=$3::uuid,
             decision_key_sha256=$4,applied_receipt=$5::jsonb,
             decided_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
      [tenantId, request.id, reviewer, decisionHash, JSON.stringify(changed)],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.draft.edit.applied",
      dedupeKey: `schedule.draft.edit.applied:${request.id}`,
      payload: { requestId: request.id, shiftId: request.shift_id },
    });
    await client.query("COMMIT");
    return {
      requestId: request.id,
      status: "applied",
      editedDraft: changed,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
