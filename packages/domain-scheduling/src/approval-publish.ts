import { createHash, randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import { enqueueOutbox, runSqlTransaction } from "../../platform-db/src/index.js";
import type { TrustedActor } from "../../platform-identity/src/index.js";
import {
  readModeLocked,
  requireOwner,
  requireScopedManager,
} from "./approval.js";
import {
  publishShiftInternal,
  type AssertMayPublishShift,
  type InternalPublishShift,
  type PublishedShiftReceipt,
} from "./publish-shift.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SchedulePublishFailureCode =
  | "SCHEDULE_PUBLISH_INVALID"
  | "SCHEDULE_PUBLISH_APPROVAL_REQUIRED"
  | "SCHEDULE_PUBLISH_APPROVAL_NOT_ENABLED"
  | "SCHEDULE_PUBLISH_REQUEST_NOT_FOUND"
  | "SCHEDULE_PUBLISH_REQUEST_STALE"
  | "SCHEDULE_PUBLISH_ALREADY_DECIDED"
  | "SCHEDULE_PUBLISH_KEY_REUSED";

export class SchedulePublishFailure extends Error {
  constructor(readonly code: SchedulePublishFailureCode) {
    super(code);
    this.name = "SchedulePublishFailure";
  }
}

export interface InternalRequestPublishShift {
  readonly actor: TrustedActor;
  readonly shiftId: string;
  readonly expectedDraftRevision: number;
  readonly idempotencyKey: string;
}

export interface InternalReviewPublishShift {
  readonly actor: TrustedActor;
  readonly requestId: string;
  readonly action: "approve" | "reject";
  readonly idempotencyKey: string;
}

export interface PublishShiftRequestReceipt {
  readonly requestId: string;
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly expectedDraftRevision: number;
  readonly policyRevision: number;
  readonly status: "pending";
}

export type PublishShiftReviewReceipt =
  | { readonly requestId: string; readonly status: "rejected" }
  | {
      readonly requestId: string;
      readonly status: "applied";
      readonly publishedShift: PublishedShiftReceipt;
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
  status: "pending" | "applied" | "rejected";
  reviewer_identity_id: string | null;
  decision_key_sha256: string | null;
  applied_receipt: PublishedShiftReceipt | null;
}

function fail(code: SchedulePublishFailureCode): never {
  throw new SchedulePublishFailure(code);
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
    fail("SCHEDULE_PUBLISH_INVALID");
  }
}

/**
 * Prospective operator-facing adapter: require direct mode in the same
 * transaction that publishes. The un-gated primitive remains INTERNAL only.
 */
export async function publishShiftDirectInternal(
  pool: Pool,
  input: InternalPublishShift,
  assertMayPublish: AssertMayPublishShift,
): Promise<PublishedShiftReceipt> {
  assertActor(input?.actor);
  if (typeof assertMayPublish !== "function") {
    fail("SCHEDULE_PUBLISH_INVALID");
  }
  return publishShiftInternal(pool, input, async (client, context) => {
    const policy = await readModeLocked(client, context.tenantId);
    if (policy.mode !== "direct") {
      fail("SCHEDULE_PUBLISH_APPROVAL_REQUIRED");
    }
    await assertMayPublish(client, context);
  });
}

/**
 * Inert request. The shift remains inactive. Stored authoritative staff,
 * location, draft_revision and exact UTC interval prevent stale approval.
 */
export async function requestPublishShiftInternal(
  pool: Pool,
  input: InternalRequestPublishShift,
): Promise<PublishShiftRequestReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.shiftId) ||
    !validRevision(input.expectedDraftRevision) ||
    !validKey(input.idempotencyKey)
  ) {
    fail("SCHEDULE_PUBLISH_INVALID");
  }
  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = digest(input.idempotencyKey);
  const requestHash = digest(
    JSON.stringify([input.shiftId, input.expectedDraftRevision]),
  );
  return runSqlTransaction<PublishShiftRequestReceipt>(pool, async (client) => {
    const initial = await client.query<ShiftRow>(
      `SELECT staff_id::text,location_id::text
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.shiftId],
    );
    const reference = initial.rows[0];
    if (!reference) fail("SCHEDULE_PUBLISH_REQUEST_NOT_FOUND");
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (!staff.rowCount) fail("SCHEDULE_PUBLISH_REQUEST_NOT_FOUND");
    const current = await client.query<ShiftRow>(
      `SELECT id::text,staff_id::text,location_id::text,active,
              draft_revision,start_at,end_at
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
      fail("SCHEDULE_PUBLISH_REQUEST_NOT_FOUND");
    }
    await requireScopedManager(
      client,
      input.actor,
      shift.staff_id,
      shift.location_id,
    );
    const policy = await readModeLocked(client, tenantId);
    if (policy.mode !== "approval") {
      fail("SCHEDULE_PUBLISH_APPROVAL_NOT_ENABLED");
    }

    const previous = await client.query<RequestRow>(
      `SELECT id::text,shift_id::text,staff_id::text,location_id::text,
              request_sha256,policy_revision,expected_draft_revision
         FROM cookie_scheduling.schedule_publish_requests
        WHERE tenant_id=$1::uuid AND requester_identity_id=$2::uuid
          AND key_sha256=$3`,
      [tenantId, actorId, keyHash],
    );
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (old.request_sha256 !== requestHash) {
        fail("SCHEDULE_PUBLISH_KEY_REUSED");
      }
      return {
        requestId: old.id,
        shiftId: old.shift_id,
        staffId: old.staff_id,
        locationId: old.location_id,
        expectedDraftRevision: old.expected_draft_revision,
        policyRevision: old.policy_revision,
        status: "pending",
      };
    }

    const now = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    if (
      shift.active ||
      shift.draft_revision !== input.expectedDraftRevision ||
      shift.start_at.getTime() <=
        (now.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY)
    ) {
      fail("SCHEDULE_PUBLISH_REQUEST_STALE");
    }
    // Only a draft created by our controlled F1 command is admissible.
    // Disabled and previously published shifts cannot be republished.
    const draftAudit = await client.query(
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
    if (!draftAudit.rowCount || published.rowCount || disabled.rowCount) {
      fail("SCHEDULE_PUBLISH_REQUEST_STALE");
    }

    const requestId = randomUUID();
    await client.query(
      `INSERT INTO cookie_scheduling.schedule_publish_requests
         (tenant_id,id,shift_id,staff_id,location_id,requester_identity_id,
          key_sha256,request_sha256,policy_revision,expected_draft_revision,
          expected_start_at,expected_end_at)
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
        input.expectedDraftRevision,
        shift.start_at,
        shift.end_at,
      ],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.publish.requested",
      dedupeKey: `schedule.publish.requested:${requestId}`,
      payload: { requestId, shiftId: shift.id, locationId: shift.location_id },
    });
    return {
      requestId,
      shiftId: shift.id,
      staffId: shift.staff_id,
      locationId: shift.location_id,
      expectedDraftRevision: input.expectedDraftRevision,
      policyRevision: policy.revision,
      status: "pending",
    };
  });
}

/**
 * Only the verified organization owner can review. Approval shares a single
 * transaction with the existing conflict-safe publish command, rechecking
 * both policy and draft revision + exact window at the commit boundary.
 */
export async function reviewPublishShiftInternal(
  pool: Pool,
  input: InternalReviewPublishShift,
  assertMayPublish: AssertMayPublishShift,
): Promise<PublishShiftReviewReceipt> {
  assertActor(input?.actor);
  if (
    !input ||
    !UUID.test(input.requestId) ||
    (input.action !== "approve" && input.action !== "reject") ||
    !validKey(input.idempotencyKey) ||
    typeof assertMayPublish !== "function"
  ) {
    fail("SCHEDULE_PUBLISH_INVALID");
  }
  const tenantId = input.actor.tenantId;
  const reviewer = input.actor.identityId;
  const decisionHash = digest(input.idempotencyKey);
  return runSqlTransaction<PublishShiftReviewReceipt>(pool, async (client) => {
    const initial = await client.query<RequestRow>(
      `SELECT shift_id::text,staff_id::text,location_id::text
         FROM cookie_scheduling.schedule_publish_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.requestId],
    );
    const reference = initial.rows[0];
    if (!reference) fail("SCHEDULE_PUBLISH_REQUEST_NOT_FOUND");
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (!staff.rowCount) fail("SCHEDULE_PUBLISH_REQUEST_NOT_FOUND");
    const result = await client.query<RequestRow>(
      `SELECT id::text,shift_id::text,staff_id::text,location_id::text,
              requester_identity_id::text,request_sha256,policy_revision,
              expected_draft_revision,expected_start_at,expected_end_at,
              status,reviewer_identity_id::text,decision_key_sha256,
              applied_receipt
         FROM cookie_scheduling.schedule_publish_requests
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.requestId],
    );
    const request = result.rows[0];
    if (
      !request ||
      request.shift_id !== reference.shift_id ||
      request.staff_id !== reference.staff_id ||
      request.location_id !== reference.location_id
    ) {
      fail("SCHEDULE_PUBLISH_REQUEST_NOT_FOUND");
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
        fail("SCHEDULE_PUBLISH_ALREADY_DECIDED");
      }
      return request.status === "applied"
        ? {
            requestId: request.id,
            status: "applied",
            publishedShift: request.applied_receipt!,
          }
        : { requestId: request.id, status: "rejected" };
    }

    // Explicit owner rejection is always allowed on a pending request,
    // including after a policy switch or changed draft.
    if (input.action === "reject") {
      await client.query(
        `UPDATE cookie_scheduling.schedule_publish_requests
           SET status='rejected',reviewer_identity_id=$3::uuid,
               decision_key_sha256=$4,decided_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
        [tenantId, request.id, reviewer, decisionHash],
      );
      await enqueueOutbox(client, {
        tenantId,
        topic: "schedule.publish.rejected",
        dedupeKey: `schedule.publish.rejected:${request.id}`,
        payload: { requestId: request.id, shiftId: request.shift_id },
      });
      return { requestId: request.id, status: "rejected" };
    }

    const policy = await readModeLocked(client, tenantId);
    if (
      policy.mode !== "approval" ||
      policy.revision !== request.policy_revision
    ) {
      fail("SCHEDULE_PUBLISH_REQUEST_STALE");
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
              draft_revision,start_at,end_at
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, request.shift_id],
    );
    const shift = lockedShift.rows[0];
    if (
      !shift ||
      shift.active ||
      shift.staff_id !== request.staff_id ||
      shift.location_id !== request.location_id ||
      shift.draft_revision !== request.expected_draft_revision ||
      shift.start_at.getTime() !== request.expected_start_at.getTime() ||
      shift.end_at.getTime() !== request.expected_end_at.getTime()
    ) {
      fail("SCHEDULE_PUBLISH_REQUEST_STALE");
    }

    const published = await publishShiftInternal(
      pool,
      {
        actor: input.actor,
        shiftId: request.shift_id,
        idempotencyKey: `publish-approval:${request.id}`,
      },
      async (transaction, context) => {
        const currentPolicy = await readModeLocked(transaction, tenantId);
        if (
          currentPolicy.mode !== "approval" ||
          currentPolicy.revision !== request.policy_revision
        ) {
          fail("SCHEDULE_PUBLISH_REQUEST_STALE");
        }
        await assertMayPublish(transaction, context);
      },
      client,
    );

    await client.query(
      `UPDATE cookie_scheduling.schedule_publish_requests
         SET status='applied',reviewer_identity_id=$3::uuid,
             decision_key_sha256=$4,applied_receipt=$5::jsonb,
             decided_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'`,
      [tenantId, request.id, reviewer, decisionHash, JSON.stringify(published)],
    );
    await enqueueOutbox(client, {
      tenantId,
      topic: "schedule.publish.applied",
      dedupeKey: `schedule.publish.applied:${request.id}`,
      payload: { requestId: request.id, shiftId: request.shift_id },
    });
    return {
      requestId: request.id,
      status: "applied",
      publishedShift: published,
    };
  });
}
