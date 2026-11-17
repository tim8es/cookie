import { createHash, randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import { enqueueOutbox } from "../../platform-db/src/index.js";
import type { TrustedActor } from "../../platform-identity/src/index.js";
import {
  readModeLocked,
  requireOwner,
  requireScopedManager,
} from "./approval.js";
import {
  createShiftDraftInternal,
  type AssertMayChangeDraft,
  type InternalCreateShiftDraft,
  type ShiftDraftReceipt,
} from "./draft-shift.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

export type DraftCreateApprovalFailureCode =
  | "DRAFT_CREATE_APPROVAL_INVALID"
  | "DRAFT_CREATE_APPROVAL_REQUIRED"
  | "DRAFT_CREATE_APPROVAL_NOT_ENABLED"
  | "DRAFT_CREATE_APPROVAL_TARGET_UNAVAILABLE"
  | "DRAFT_CREATE_APPROVAL_NOT_FOUND"
  | "DRAFT_CREATE_APPROVAL_STALE"
  | "DRAFT_CREATE_APPROVAL_ALREADY_DECIDED"
  | "DRAFT_CREATE_APPROVAL_KEY_REUSED";

export class DraftCreateApprovalFailure extends Error {
  constructor(readonly code: DraftCreateApprovalFailureCode) {
    super(code);
    this.name = "DraftCreateApprovalFailure";
  }
}

export interface InternalRequestDraftCreate {
  readonly actor: TrustedActor;
  readonly staffId: string;
  readonly locationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly idempotencyKey: string;
}
export interface InternalReviewDraftCreate {
  readonly actor: TrustedActor;
  readonly requestId: string;
  readonly action: "approve" | "reject";
  readonly idempotencyKey: string;
}
export interface DraftCreateRequestReceipt {
  readonly requestId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly policyRevision: number;
  readonly status: "pending";
}
export type DraftCreateReviewReceipt =
  | { readonly requestId: string; readonly status: "rejected" }
  | {
      readonly requestId: string;
      readonly status: "applied";
      readonly createdDraft: ShiftDraftReceipt;
    };

interface RequestRow extends QueryResultRow {
  id: string;
  staff_id: string;
  location_id: string;
  requester_identity_id: string;
  request_sha256: string;
  policy_revision: number;
  proposed_start_at: Date;
  proposed_end_at: Date;
  status: "pending" | "applied" | "rejected";
  reviewer_identity_id: string | null;
  decision_key_sha256: string | null;
  applied_receipt: ShiftDraftReceipt | null;
}
interface TargetRow extends QueryResultRow {
  time_zone: string | null;
}

function fail(code: DraftCreateApprovalFailureCode): never {
  throw new DraftCreateApprovalFailure(code);
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function validKey(value: string): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
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
    fail("DRAFT_CREATE_APPROVAL_INVALID");
  }
}
function parseMinute(value: string): string {
  if (typeof value !== "string" || !UTC_MINUTE.test(value)) {
    fail("DRAFT_CREATE_APPROVAL_INVALID");
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    fail("DRAFT_CREATE_APPROVAL_INVALID");
  }
  return new Date(parsed).toISOString();
}
function parseRange(input: InternalRequestDraftCreate): {
  startAt: string;
  endAt: string;
} {
  const startAt = parseMinute(input.startAt);
  const endAt = parseMinute(input.endAt);
  const duration = Date.parse(endAt) - Date.parse(startAt);
  if (duration <= 0 || duration > 48 * 60 * 60 * 1000) {
    fail("DRAFT_CREATE_APPROVAL_INVALID");
  }
  return { startAt, endAt };
}

/** Operator-facing direct adapter; lower-level creation is trusted-only. */
export async function createShiftDraftDirectInternal(
  pool: Pool,
  input: InternalCreateShiftDraft,
  assertMayChange: AssertMayChangeDraft,
): Promise<ShiftDraftReceipt> {
  assertActor(input?.actor);
  if (typeof assertMayChange !== "function") {
    fail("DRAFT_CREATE_APPROVAL_INVALID");
  }
  return createShiftDraftInternal(pool, input, async (client, context) => {
    const policy = await readModeLocked(client, input.actor.tenantId);
    if (policy.mode !== "direct") {
      fail("DRAFT_CREATE_APPROVAL_REQUIRED");
    }
    await assertMayChange(client, context);
  });
}

/**
 * Request submission is inert: no ShiftWindow, audit of created shift,
 * availability or booking slot is written. StaffProfile locking serializes
 * against the same staff's booking and scheduling operations.
 */
export async function requestShiftDraftCreateInternal(
  pool: Pool,
  input: InternalRequestDraftCreate,
): Promise<DraftCreateRequestReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.staffId) ||
    !UUID.test(input.locationId) ||
    !validKey(input.idempotencyKey)
  ) {
    fail("DRAFT_CREATE_APPROVAL_INVALID");
  }
  const { startAt, endAt } = parseRange(input);
  const tenantId = input.actor.tenantId;
  const requesterId = input.actor.identityId;
  const keyHash = digest(input.idempotencyKey);
  const requestHash = digest(
    JSON.stringify([input.staffId, input.locationId, startAt, endAt]),
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock order: StaffProfile -> assignment/location -> Organization policy.
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.staffId],
    );
    if (!staff.rowCount) fail("DRAFT_CREATE_APPROVAL_TARGET_UNAVAILABLE");
    await requireScopedManager(
      client,
      input.actor,
      input.staffId,
      input.locationId,
    );
    const mode = await readModeLocked(client, tenantId);
    if (mode.mode !== "approval") {
      fail("DRAFT_CREATE_APPROVAL_NOT_ENABLED");
    }

    const previous = await client.query<RequestRow>(
      `SELECT id::text,staff_id::text,location_id::text,request_sha256,
              policy_revision,proposed_start_at,proposed_end_at
         FROM cookie_scheduling.schedule_draft_create_requests
        WHERE tenant_id=$1::uuid AND requester_identity_id=$2::uuid
          AND key_sha256=$3`,
      [tenantId, requesterId, keyHash],
    );
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (old.request_sha256 !== requestHash) {
        fail("DRAFT_CREATE_APPROVAL_KEY_REUSED");
      }
      await client.query("COMMIT");
      return {
        requestId: old.id,
        staffId: old.staff_id,
        locationId: old.location_id,
        startAt: old.proposed_start_at.toISOString(),
        endAt: old.proposed_end_at.toISOString(),
        policyRevision: old.policy_revision,
        status: "pending",
      };
    }

    const target = await client.query<TargetRow>(
      `SELECT location.time_zone
         FROM cookie_staff.location_assignments AS assignment
         JOIN cookie_staff.staff_profiles AS profile
           ON profile.tenant_id=assignment.tenant_id
          AND profile.id=assignment.staff_id
         JOIN cookie_tenancy.locations AS location
           ON location.tenant_id=assignment.tenant_id
          AND location.id=assignment.location_id
        WHERE assignment.tenant_id=$1::uuid
          AND assignment.staff_id=$2::uuid
          AND assignment.location_id=$3::uuid
          AND assignment.active AND profile.active
        FOR SHARE OF assignment,location`,
      [tenantId, input.staffId, input.locationId],
    );
    const zone = target.rows[0]?.time_zone;
    if (!zone) fail("DRAFT_CREATE_APPROVAL_TARGET_UNAVAILABLE");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    } catch {
      fail("DRAFT_CREATE_APPROVAL_TARGET_UNAVAILABLE");
    }

    const time = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    if (Date.parse(startAt) <= (time.rows[0]?.now.getTime() ?? Infinity)) {
      fail("DRAFT_CREATE_APPROVAL_STALE");
    }

    const requestId = randomUUID();
    await client.query(
      `INSERT INTO cookie_scheduling.schedule_draft_create_requests
         (tenant_id,id,staff_id,location_id,requester_identity_id,
          key_sha256,request_sha256,policy_revision,
          proposed_start_at,proposed_end_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
               $6,$7,$8,$9::timestamptz,$10::timestamptz)`,
      [
        tenantId,
        requestId,
        input.staffId,
        input.locationId,
        requesterId,
        keyHash,
        requestHash,
        mode.revision,
        startAt,
        endAt,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.draft.create.requested",
      dedupeKey: `schedule.draft.create.requested:${requestId}`,
      payload: {
        requestId,
        staffId: input.staffId,
        locationId: input.locationId,
      },
    });
    await client.query("COMMIT");
    return {
      requestId,
      staffId: input.staffId,
      locationId: input.locationId,
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

/**
 * Only actual active Organization owner may review. Creating a draft and
 * making the request terminal are ONE SQL transaction. On any failure the
 * pending request survives and no ShiftWindow is created.
 */
export async function reviewShiftDraftCreateInternal(
  pool: Pool,
  input: InternalReviewDraftCreate,
  assertMayChange: AssertMayChangeDraft,
): Promise<DraftCreateReviewReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.requestId) ||
    (input.action !== "approve" && input.action !== "reject") ||
    !validKey(input.idempotencyKey) ||
    typeof assertMayChange !== "function"
  ) {
    fail("DRAFT_CREATE_APPROVAL_INVALID");
  }

  const tenantId = input.actor.tenantId;
  const reviewer = input.actor.identityId;
  const decisionHash = digest(input.idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const initial = await client.query<RequestRow>(
      `SELECT staff_id::text,location_id::text
         FROM cookie_scheduling.schedule_draft_create_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.requestId],
    );
    const reference = initial.rows[0];
    if (!reference) fail("DRAFT_CREATE_APPROVAL_NOT_FOUND");
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (!staff.rowCount) fail("DRAFT_CREATE_APPROVAL_TARGET_UNAVAILABLE");

    const current = await client.query<RequestRow>(
      `SELECT id::text,staff_id::text,location_id::text,
              requester_identity_id::text,policy_revision,
              proposed_start_at,proposed_end_at,status,
              reviewer_identity_id::text,decision_key_sha256,applied_receipt
         FROM cookie_scheduling.schedule_draft_create_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.requestId],
    );
    const request = current.rows[0];
    if (
      !request ||
      request.staff_id !== reference.staff_id ||
      request.location_id !== reference.location_id
    ) {
      fail("DRAFT_CREATE_APPROVAL_NOT_FOUND");
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
        fail("DRAFT_CREATE_APPROVAL_ALREADY_DECIDED");
      }
      await client.query("COMMIT");
      return request.status === "applied"
        ? {
            requestId: request.id,
            status: "applied",
            createdDraft: request.applied_receipt!,
          }
        : { requestId: request.id, status: "rejected" };
    }

    if (input.action === "reject") {
      await client.query(
        `UPDATE cookie_scheduling.schedule_draft_create_requests
           SET status='rejected',reviewer_identity_id=$3::uuid,
               decision_key_sha256=$4,decided_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
        [tenantId, request.id, reviewer, decisionHash],
      );
      await enqueueOutbox(client, {
        tenantId,
        topic: "schedule.draft.create.rejected",
        dedupeKey: `schedule.draft.create.rejected:${request.id}`,
        payload: { requestId: request.id },
      });
      await client.query("COMMIT");
      return { requestId: request.id, status: "rejected" };
    }

    const mode = await readModeLocked(client, tenantId);
    if (mode.mode !== "approval" || mode.revision !== request.policy_revision) {
      fail("DRAFT_CREATE_APPROVAL_STALE");
    }
    // No stored shift exists yet: reauthorize requester over the stored
    // target and revalidate its assignment, IANA zone and future range
    // inside the protected creation command, at approval time.
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

    const created = await createShiftDraftInternal(
      pool,
      {
        actor: input.actor,
        staffId: request.staff_id,
        locationId: request.location_id,
        startAt: request.proposed_start_at.toISOString().replace(".000Z", "Z"),
        endAt: request.proposed_end_at.toISOString().replace(".000Z", "Z"),
        idempotencyKey: `draft-create-approval:${request.id}`,
      },
      async (transaction, context) => {
        const currentMode = await readModeLocked(transaction, tenantId);
        if (
          currentMode.mode !== "approval" ||
          currentMode.revision !== request.policy_revision
        ) {
          fail("DRAFT_CREATE_APPROVAL_STALE");
        }
        await assertMayChange(transaction, context);
      },
      client,
    );

    await client.query(
      `UPDATE cookie_scheduling.schedule_draft_create_requests
         SET status='applied',reviewer_identity_id=$3::uuid,
             decision_key_sha256=$4,applied_receipt=$5::jsonb,
             decided_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
      [tenantId, request.id, reviewer, decisionHash, JSON.stringify(created)],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.draft.create.applied",
      dedupeKey: `schedule.draft.create.applied:${request.id}`,
      payload: {
        requestId: request.id,
        shiftId: created.shiftId,
        locationId: request.location_id,
      },
    });
    await client.query("COMMIT");
    return {
      requestId: request.id,
      status: "applied",
      createdDraft: created,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
