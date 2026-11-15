import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";
import {
  editPublishedShiftInternal,
  type AssertMayEditPublishedShift,
  type EditedPublishedShiftReceipt,
  type InternalEditPublishedShift,
} from "./edit-published-shift.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

export type ScheduleEditMode = "direct" | "approval";
export type ReviewAction = "approve" | "reject";

export type ScheduleApprovalFailureCode =
  | "SCHEDULE_APPROVAL_INVALID"
  | "SCHEDULE_APPROVAL_OWNER_REQUIRED"
  | "SCHEDULE_APPROVAL_MODE_UNCHANGED"
  | "SCHEDULE_APPROVAL_MODE_STALE"
  | "SCHEDULE_APPROVAL_REQUIRED"
  | "SCHEDULE_APPROVAL_NOT_ENABLED"
  | "SCHEDULE_APPROVAL_REQUEST_NOT_FOUND"
  | "SCHEDULE_APPROVAL_REQUEST_STALE"
  | "SCHEDULE_APPROVAL_REQUEST_CONFLICT"
  | "SCHEDULE_APPROVAL_ALREADY_DECIDED"
  | "SCHEDULE_APPROVAL_KEY_REUSED"
  | "SCHEDULE_APPROVAL_POLICY_DENIED";

export class ScheduleApprovalFailure extends Error {
  constructor(readonly code: ScheduleApprovalFailureCode) {
    super(code);
    this.name = "ScheduleApprovalFailure";
  }
}

export interface SchedulePolicyReceipt {
  readonly tenantId: string;
  readonly mode: ScheduleEditMode;
  readonly revision: number;
}

export interface InternalSetSchedulePolicy {
  readonly actor: TrustedActor;
  readonly mode: ScheduleEditMode;
  readonly expectedRevision: number;
}

export interface InternalRequestPublishedShiftEdit {
  readonly actor: TrustedActor;
  readonly shiftId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly expectedPublishedRevision: number;
  readonly idempotencyKey: string;
}

export interface ScheduleEditRequestReceipt {
  readonly requestId: string;
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly expectedPublishedRevision: number;
  readonly policyRevision: number;
  readonly status: "pending";
}

export interface InternalReviewScheduleEdit {
  readonly actor: TrustedActor;
  readonly requestId: string;
  readonly action: ReviewAction;
  readonly idempotencyKey: string;
}

export type ScheduleReviewReceipt =
  | { readonly requestId: string; readonly status: "rejected" }
  | {
      readonly requestId: string;
      readonly status: "applied";
      readonly editedShift: EditedPublishedShiftReceipt;
    };

interface ModeRow extends QueryResultRow {
  mode: ScheduleEditMode;
  revision: number;
}
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
  new_start_at: Date;
  new_end_at: Date;
  status: "pending" | "applied" | "rejected";
  reviewer_identity_id: string | null;
  decision_key_sha256: string | null;
  applied_receipt: EditedPublishedShiftReceipt | null;
}

function fail(code: ScheduleApprovalFailureCode): never {
  throw new ScheduleApprovalFailure(code);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
    fail("SCHEDULE_APPROVAL_INVALID");
  }
}

function validKey(key: string): boolean {
  return typeof key === "string" && key.length >= 1 && key.length <= 128;
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < 2147483647;
}

function parseMinute(value: string): string {
  if (typeof value !== "string" || !UTC_MINUTE.test(value)) {
    fail("SCHEDULE_APPROVAL_INVALID");
  }
  const ms = Date.parse(value);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    fail("SCHEDULE_APPROVAL_INVALID");
  }
  return new Date(ms).toISOString();
}

function range(start: string, end: string): {
  readonly startAt: string;
  readonly endAt: string;
} {
  const startAt = parseMinute(start);
  const endAt = parseMinute(end);
  const elapsed = Date.parse(endAt) - Date.parse(startAt);
  if (elapsed <= 0 || elapsed > 48 * 60 * 60 * 1000) {
    fail("SCHEDULE_APPROVAL_INVALID");
  }
  return { startAt, endAt };
}

/**
 * Default mode is APPROVAL when the policy row does not exist. Locking the
 * Organization row with FOR SHARE serializes with owner-only updates, so
 * changing the mode cannot race a draft request or an approval commit.
 */
async function readModeLocked(
  client: PoolClient,
  tenantId: string,
): Promise<SchedulePolicyReceipt> {
  const org = await client.query(
    `SELECT id FROM cookie_tenancy.organizations
      WHERE id=$1::uuid FOR SHARE`,
    [tenantId],
  );
  if (!org.rowCount) fail("SCHEDULE_APPROVAL_INVALID");
  const rows = await client.query<ModeRow>(
    `SELECT mode,revision FROM cookie_scheduling.schedule_edit_policies
      WHERE tenant_id=$1::uuid`,
    [tenantId],
  );
  return {
    tenantId,
    mode: rows.rows[0]?.mode ?? "approval",
    revision: rows.rows[0]?.revision ?? 0,
  };
}

async function requireOwner(
  client: PoolClient,
  actor: TrustedActor,
): Promise<void> {
  const owner = await client.query(
    `SELECT 1 FROM cookie_tenancy.organizations AS org
      JOIN cookie_identity.memberships AS member
        ON member.tenant_id=org.id
       AND member.identity_id=org.owner_identity_id AND member.active
      WHERE org.id=$1::uuid AND org.owner_identity_id=$2::uuid`,
    [actor.tenantId, actor.identityId],
  );
  if (!owner.rowCount) fail("SCHEDULE_APPROVAL_OWNER_REQUIRED");
  // Recheck active organization permission; a role named "owner" alone is
  // not proof of ownership. Both conditions are mandatory.
  await requireTenantPermission(
    client,
    actor,
    { kind: "organization", tenantId: actor.tenantId },
    "schedule.manage",
  );
}

async function requireScopedManager(
  client: PoolClient,
  actor: TrustedActor,
  staffId: string,
  locationId: string,
): Promise<void> {
  await requireTenantPermission(
    client,
    actor,
    {
      kind: "schedule",
      tenantId: actor.tenantId,
      staffProfileId: staffId,
      locationId,
    },
    "schedule.manage",
  );
}

/**
 * Trusted internal owner-only CAS. The default/absent policy is approval@0.
 * Does not change any shift or auto-approve existing requests.
 */
export async function setScheduleEditPolicyInternal(
  pool: Pool,
  input: InternalSetSchedulePolicy,
): Promise<SchedulePolicyReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    (input.mode !== "direct" && input.mode !== "approval") ||
    !validRevision(input.expectedRevision)
  ) {
    fail("SCHEDULE_APPROVAL_INVALID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Owner modification takes Organization FOR UPDATE, and all execution
    // and request paths take its FOR SHARE lock.
    const org = await client.query(
      `SELECT id FROM cookie_tenancy.organizations
         WHERE id=$1::uuid FOR UPDATE`,
      [input.actor.tenantId],
    );
    if (!org.rowCount) fail("SCHEDULE_APPROVAL_OWNER_REQUIRED");
    await requireOwner(client, input.actor);
    const actual = await client.query<ModeRow>(
      `SELECT mode,revision FROM cookie_scheduling.schedule_edit_policies
         WHERE tenant_id=$1::uuid FOR UPDATE`,
      [input.actor.tenantId],
    );
    const current = actual.rows[0];
    const oldMode = current?.mode ?? "approval";
    const revision = current?.revision ?? 0;
    if (revision !== input.expectedRevision) {
      fail("SCHEDULE_APPROVAL_MODE_STALE");
    }
    if (oldMode === input.mode) fail("SCHEDULE_APPROVAL_MODE_UNCHANGED");

    const next = revision + 1;
    await client.query(
      `INSERT INTO cookie_scheduling.schedule_edit_policies
         (tenant_id,mode,revision,changed_by)
       VALUES ($1::uuid,$2,$3,$4::uuid)
       ON CONFLICT (tenant_id) DO UPDATE
          SET mode=EXCLUDED.mode,revision=EXCLUDED.revision,
              changed_by=EXCLUDED.changed_by,changed_at=clock_timestamp()`,
      [input.actor.tenantId, input.mode, next, input.actor.identityId],
    );
    await client.query(
      `INSERT INTO cookie_scheduling.schedule_edit_policy_audit
         (tenant_id,id,actor_identity_id,correlation_id,
          old_mode,new_mode,old_revision,new_revision)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)`,
      [
        input.actor.tenantId,
        randomUUID(),
        input.actor.identityId,
        input.actor.correlationId,
        oldMode,
        input.mode,
        revision,
        next,
      ],
    );
    await enqueueOutbox(client, {
      tenantId: input.actor.tenantId,
      topic: "schedule.edit.mode.changed",
      dedupeKey: `schedule.edit.mode.changed:${next}`,
      payload: { mode: input.mode, revision: next },
    });
    await client.query("COMMIT");
    return { tenantId: input.actor.tenantId, mode: input.mode, revision: next };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Route ALL direct published-shift edits through this adapter. It uses the
 * pre-existing booking-safe edit command, with a transaction-local policy
 * guard. An approval-mode organization cannot bypass this adapter.
 */
export async function editPublishedShiftDirectInternal(
  pool: Pool,
  input: InternalEditPublishedShift,
  assertMayEdit: AssertMayEditPublishedShift,
): Promise<EditedPublishedShiftReceipt> {
  assertActor(input?.actor);
  if (typeof assertMayEdit !== "function") {
    fail("SCHEDULE_APPROVAL_INVALID");
  }
  return editPublishedShiftInternal(pool, input, async (client, context) => {
    const policy = await readModeLocked(client, context.tenantId);
    if (policy.mode !== "direct") fail("SCHEDULE_APPROVAL_REQUIRED");
    await assertMayEdit(client, context);
  });
}

/**
 * Create a non-executable pending request for an existing published shift.
 * Caller must already have schedule.manage for the authoritative branch.
 * No booking, shift time or availability state changes on submission.
 */
export async function requestPublishedShiftEditInternal(
  pool: Pool,
  input: InternalRequestPublishedShiftEdit,
): Promise<ScheduleEditRequestReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.shiftId) ||
    !validKey(input.idempotencyKey) ||
    !validRevision(input.expectedPublishedRevision)
  ) {
    fail("SCHEDULE_APPROVAL_INVALID");
  }
  const { startAt, endAt } = range(input.startAt, input.endAt);
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reference = await client.query<ShiftRow>(
      `SELECT staff_id::text, location_id::text
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.shiftId],
    );
    if (!reference.rows[0]) fail("SCHEDULE_APPROVAL_REQUEST_NOT_FOUND");
    const staffId = reference.rows[0].staff_id;
    const locationId = reference.rows[0].location_id;
    const staffLock = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, staffId],
    );
    if (!staffLock.rowCount) fail("SCHEDULE_APPROVAL_REQUEST_NOT_FOUND");
    const shiftResult = await client.query<ShiftRow>(
      `SELECT id::text,staff_id::text,location_id::text,active,
              published_revision,start_at,end_at
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.shiftId],
    );
    const shift = shiftResult.rows[0];
    if (
      !shift ||
      shift.staff_id !== staffId ||
      shift.location_id !== locationId
    ) {
      fail("SCHEDULE_APPROVAL_REQUEST_NOT_FOUND");
    }
    await requireScopedManager(client, input.actor, staffId, locationId);
    const policy = await readModeLocked(client, tenantId);
    if (policy.mode !== "approval") fail("SCHEDULE_APPROVAL_NOT_ENABLED");

    const previous = await client.query<RequestRow>(
      `SELECT id::text,shift_id::text,staff_id::text,location_id::text,
              requester_identity_id::text,request_sha256,policy_revision,
              expected_published_revision,new_start_at,new_end_at,status
         FROM cookie_scheduling.schedule_edit_requests
        WHERE tenant_id=$1::uuid AND requester_identity_id=$2::uuid
          AND key_sha256=$3`,
      [tenantId, actorId, keyHash],
    );
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (old.request_sha256 !== requestHash) {
        fail("SCHEDULE_APPROVAL_KEY_REUSED");
      }
      await client.query("COMMIT");
      return {
        requestId: old.id,
        shiftId: old.shift_id,
        staffId: old.staff_id,
        locationId: old.location_id,
        startAt: old.new_start_at.toISOString(),
        endAt: old.new_end_at.toISOString(),
        expectedPublishedRevision: old.expected_published_revision,
        policyRevision: old.policy_revision,
        status: "pending",
      };
    }
    if (
      !shift.active ||
      shift.published_revision !== input.expectedPublishedRevision ||
      shift.start_at.getTime() <= Date.now() ||
      Date.parse(startAt) <= Date.now()
    ) {
      fail("SCHEDULE_APPROVAL_REQUEST_STALE");
    }
    if (
      shift.start_at.toISOString() === startAt &&
      shift.end_at.toISOString() === endAt
    ) {
      fail("SCHEDULE_APPROVAL_REQUEST_CONFLICT");
    }
    const audit = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_publish_audit
         WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
       UNION ALL
       SELECT 1 FROM cookie_scheduling.shift_disable_audit
         WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
       LIMIT 1`,
      [tenantId, shift.id],
    );
    // Require published provenance without historical deactivation.
    const verifiedPublication = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_publish_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid LIMIT 1`,
      [tenantId, shift.id],
    );
    const disabled = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_disable_audit
         WHERE tenant_id=$1::uuid AND shift_id=$2::uuid LIMIT 1`,
      [tenantId, shift.id],
    );
    if (!audit.rowCount || !verifiedPublication.rowCount || disabled.rowCount) {
      fail("SCHEDULE_APPROVAL_REQUEST_STALE");
    }

    const requestId = randomUUID();
    await client.query(
      `INSERT INTO cookie_scheduling.schedule_edit_requests
         (tenant_id,id,shift_id,staff_id,location_id,requester_identity_id,
          key_sha256,request_sha256,policy_revision,
          expected_published_revision,new_start_at,new_end_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,
               $7,$8,$9,$10,$11::timestamptz,$12::timestamptz)`,
      [
        tenantId,
        requestId,
        shift.id,
        staffId,
        locationId,
        actorId,
        keyHash,
        requestHash,
        policy.revision,
        input.expectedPublishedRevision,
        startAt,
        endAt,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.edit.requested",
      dedupeKey: `schedule.edit.requested:${requestId}`,
      payload: { requestId, shiftId: shift.id, locationId },
    });
    await client.query("COMMIT");
    return {
      requestId,
      shiftId: shift.id,
      staffId,
      locationId,
      startAt,
      endAt,
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
 * Only the organization's verified owner can review. Approval invokes the
 * existing booking-safe time-edit operation INSIDE this very transaction;
 * policy, request decision, shift revision, bookings and outbox cannot
 * commit in different database states. Conflict leaves request pending.
 */
export async function reviewScheduleEditRequestInternal(
  pool: Pool,
  input: InternalReviewScheduleEdit,
  assertMayEdit: AssertMayEditPublishedShift,
): Promise<ScheduleReviewReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.requestId) ||
    (input.action !== "approve" && input.action !== "reject") ||
    !validKey(input.idempotencyKey) ||
    typeof assertMayEdit !== "function"
  ) {
    fail("SCHEDULE_APPROVAL_INVALID");
  }
  const tenantId = input.actor.tenantId;
  const reviewer = input.actor.identityId;
  const decisionHash = digest(input.idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const meta = await client.query<RequestRow>(
      `SELECT staff_id::text,location_id::text,shift_id::text
         FROM cookie_scheduling.schedule_edit_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.requestId],
    );
    if (!meta.rows[0]) fail("SCHEDULE_APPROVAL_REQUEST_NOT_FOUND");
    const reference = meta.rows[0];
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (!staff.rowCount) fail("SCHEDULE_APPROVAL_REQUEST_NOT_FOUND");
    const result = await client.query<RequestRow>(
      `SELECT id::text,shift_id::text,staff_id::text,location_id::text,
          requester_identity_id::text,policy_revision,
          expected_published_revision,new_start_at,new_end_at,
          status,reviewer_identity_id::text,decision_key_sha256,applied_receipt
         FROM cookie_scheduling.schedule_edit_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.requestId],
    );
    const request = result.rows[0];
    if (
      !request ||
      request.staff_id !== reference.staff_id ||
      request.location_id !== reference.location_id ||
      request.shift_id !== reference.shift_id
    ) {
      fail("SCHEDULE_APPROVAL_REQUEST_NOT_FOUND");
    }
    await requireOwner(client, input.actor);
    await requireScopedManager(client, input.actor, request.staff_id, request.location_id);

    if (request.status !== "pending") {
      const expectedStatus = input.action === "approve" ? "applied" : "rejected";
      if (
        request.status !== expectedStatus ||
        request.reviewer_identity_id !== reviewer ||
        request.decision_key_sha256 !== decisionHash
      ) {
        fail("SCHEDULE_APPROVAL_ALREADY_DECIDED");
      }
      await client.query("COMMIT");
      return request.status === "applied"
        ? {
            requestId: request.id,
            status: "applied",
            editedShift: request.applied_receipt!,
          }
        : { requestId: request.id, status: "rejected" };
    }

    const policy = await readModeLocked(client, tenantId);
    if (input.action === "approve") {
      if (
        policy.mode !== "approval" ||
        request.policy_revision !== policy.revision
      ) {
        fail("SCHEDULE_APPROVAL_MODE_STALE");
      }
      // Requested authorization is RE-CHECKED at approval. A request cannot
      // retain rights of an employee whose membership or role was revoked.
      const requesterActor: TrustedActor = {
        tenantId,
        identityId: request.requester_identity_id,
        correlationId: input.actor.correlationId,
      };
      await requireScopedManager(
        client,
        requesterActor,
        request.staff_id,
        request.location_id,
      );
      const changed = await editPublishedShiftInternal(
        pool,
        {
          actor: input.actor,
          shiftId: request.shift_id,
          startAt: request.new_start_at.toISOString().replace(".000Z", "Z"),
          endAt: request.new_end_at.toISOString().replace(".000Z", "Z"),
          expectedPublishedRevision: request.expected_published_revision,
          idempotencyKey: `approval:${request.id}`,
        },
        async (transaction, context) => {
          const current = await readModeLocked(transaction, tenantId);
          if (
            current.mode !== "approval" ||
            current.revision !== request.policy_revision
          ) {
            fail("SCHEDULE_APPROVAL_MODE_STALE");
          }
          await assertMayEdit(transaction, context);
        },
        client,
      );
      await client.query(
        `UPDATE cookie_scheduling.schedule_edit_requests
           SET status='applied',reviewer_identity_id=$3::uuid,
               decision_key_sha256=$4,applied_receipt=$5::jsonb,
               decided_at=clock_timestamp()
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
        [tenantId, request.id, reviewer, decisionHash, JSON.stringify(changed)],
      );
      await enqueueOutbox(client, {
        tenantId,
        topic: "schedule.edit.applied",
        dedupeKey: `schedule.edit.applied:${request.id}`,
        payload: { requestId: request.id, shiftId: request.shift_id },
      });
      await client.query("COMMIT");
      return { requestId: request.id, status: "applied", editedShift: changed };
    }

    await client.query(
      `UPDATE cookie_scheduling.schedule_edit_requests
         SET status='rejected',reviewer_identity_id=$3::uuid,
             decision_key_sha256=$4,decided_at=clock_timestamp()
       WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
      [tenantId, request.id, reviewer, decisionHash],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.edit.rejected",
      dedupeKey: `schedule.edit.rejected:${request.id}`,
      payload: { requestId: request.id, shiftId: request.shift_id },
    });
    await client.query("COMMIT");
    return { requestId: request.id, status: "rejected" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
