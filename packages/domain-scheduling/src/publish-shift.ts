import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { lockLiveStagingGrant } from "../../domain-entitlement/src/staging.js";
import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PublishShiftFailureCode =
  | "INVALID_SHIFT_PUBLISH"
  | "SHIFT_NOT_FOUND"
  | "SHIFT_ALREADY_ACTIVE"
  | "SHIFT_NOT_FUTURE"
  | "SHIFT_TARGET_UNAVAILABLE"
  | "SHIFT_CROSS_LOCATION_CONFLICT"
  | "SHIFT_REACTIVATION_REQUIRES_REVIEW"
  | "SHIFT_POLICY_DENIED"
  | "SHIFT_KEY_REUSED"
  | "SHIFT_STALE_REVISION";

export class PublishShiftFailure extends Error {
  constructor(readonly code: PublishShiftFailureCode) {
    super(code);
    this.name = "PublishShiftFailure";
  }
}

export interface InternalPublishShift {
  /** Trusted server-side identity only; never accept session claims in JSON. */
  readonly actor: TrustedActor;
  readonly shiftId: string;
  readonly idempotencyKey: string;
}

export interface PublishedShiftReceipt {
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly active: true;
}

/** Mandatory policy/approval adapter, executed in the same transaction. */
export type AssertMayPublishShift = (
  client: PoolClient,
  context: {
    readonly tenantId: string;
    readonly shiftId: string;
    readonly staffId: string;
    readonly locationId: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly actor: TrustedActor;
  },
) => Promise<void>;

interface ShiftRow extends QueryResultRow {
  id: string;
  staff_id: string;
  location_id: string;
  start_at: Date;
  end_at: Date;
  active: boolean;
  draft_revision: number;
}

interface TargetRow extends QueryResultRow {
  time_zone: string | null;
}

interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  result: PublishedShiftReceipt;
}

function reject(code: PublishShiftFailureCode): never {
  throw new PublishShiftFailure(code);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validate(input: InternalPublishShift): void {
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
    input.idempotencyKey.length > 128
  ) {
    reject("INVALID_SHIFT_PUBLISH");
  }
}

/**
 * INTERNAL F1: publish an existing *draft* future shift only. This is a
 * conservative safe slice, not a final product policy for multi-location
 * overlapping shifts, approval workflows, or staff travel.
 *
 * Staff row lock serializes with CreateBooking, RescheduleBooking,
 * CancelBooking, AddScheduleBlock and DisableShift; the shift row is locked
 * only after the staff row. All external SQL writers must share that order.
 */
export async function publishShiftInternal(
  pool: Pool,
  input: InternalPublishShift,
  assertMayPublish: AssertMayPublishShift,
  /** For trusted internal approval composition; caller manages SQL transaction. */
  transactionClient?: PoolClient,
): Promise<PublishedShiftReceipt> {
  return publishShift(pool, input, assertMayPublish, transactionClient);
}

/** Controlled staging only. The caller cannot supply a policy callback. */
export async function publishStagingOwnerShift(
  pool: Pool,
  input: InternalPublishShift & { readonly expectedRevision: number },
): Promise<PublishedShiftReceipt> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      input.expectedRevision >= 2147483647) reject("INVALID_SHIFT_PUBLISH");
  return publishShift(pool, input, undefined, undefined, input.expectedRevision);
}

async function publishShift(
  pool: Pool,
  input: InternalPublishShift,
  assertMayPublish: AssertMayPublishShift | undefined,
  transactionClient?: PoolClient,
  stagingRevision?: number,
): Promise<PublishedShiftReceipt> {
  validate(input);
  const staging = stagingRevision !== undefined;
  if (!staging && typeof assertMayPublish !== "function") {
    reject("INVALID_SHIFT_PUBLISH");
  }
  const tenantId = input.actor.tenantId;
  const actorId = input.actor.identityId;
  const keyHash = digest(staging ? "staging-owner-v1:" + input.idempotencyKey : input.idempotencyKey);
  const requestHash = digest(JSON.stringify(staging ? ["staging-owner-v1", input.shiftId, stagingRevision] : [input.shiftId]));
  const client = transactionClient ?? (await pool.connect());
  const ownsTransaction = transactionClient === undefined;
  let active = false;
  let discard = false;
  try {
    if (ownsTransaction) await client.query("BEGIN");
    active = true;

    // Never let a request supply or override the authoritative staff/branch.
    const initial = await client.query<ShiftRow>(
      `SELECT staff_id::text, location_id::text
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.shiftId],
    );
    const reference = initial.rows[0];
    if (!reference) reject("SHIFT_NOT_FOUND");

    const lock = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, reference.staff_id],
    );
    if (lock.rowCount !== 1) reject("SHIFT_NOT_FOUND");

    const current = await client.query<ShiftRow>(
      `SELECT id::text, staff_id::text, location_id::text,
              start_at, end_at, active, draft_revision
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
      staging ? "staging.shift.publish" : "schedule.manage",
    );

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [JSON.stringify([tenantId, actorId, "schedule.shift.publish", keyHash])],
    );
    const old = await client.query<ReceiptRow>(
      `SELECT request_sha256, result
         FROM cookie_scheduling.shift_publish_receipts
        WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
          AND key_sha256=$3`,
      [tenantId, actorId, keyHash],
    );
    const previous = old.rows[0];
    // Current grant is required even on a historical receipt replay.
    const grant = staging ? await lockLiveStagingGrant(client, tenantId) : undefined;
    if (previous) {
      if (previous.request_sha256 !== requestHash) reject("SHIFT_KEY_REUSED");
      if (ownsTransaction) await client.query("COMMIT");
      active = false;
      return previous.result;
    }

    if (shift.active) reject("SHIFT_ALREADY_ACTIVE");
    if (staging && shift.draft_revision !== stagingRevision) reject("SHIFT_STALE_REVISION");

    const originalPublication = await client.query(
      `SELECT id FROM cookie_scheduling.shift_publish_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
        LIMIT 1`,
      [tenantId, shift.id],
    );
    const priorDeactivation = await client.query(
      `SELECT id FROM cookie_scheduling.shift_disable_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
        LIMIT 1`,
      [tenantId, shift.id],
    );
    if (originalPublication.rowCount || priorDeactivation.rowCount) {
      reject("SHIFT_REACTIVATION_REQUIRES_REVIEW");
    }

    const clock = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    if (
      shift.start_at.getTime() <=
      (clock.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY)
    ) {
      reject("SHIFT_NOT_FUTURE");
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
        FOR SHARE OF assignment, staff, location`,
      [tenantId, shift.staff_id, shift.location_id],
    );
    const zone = target.rows[0]?.time_zone;
    if (!zone) reject("SHIFT_TARGET_UNAVAILABLE");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    } catch {
      reject("SHIFT_TARGET_UNAVAILABLE");
    }

    if (staging) {
      // Require the exact active placement previously published against this
      // grant, not an arbitrary bookable flag or borrowed active service.
      const placement = await client.query(
        `SELECT sa.service_id FROM cookie_staff.staging_publication_receipts receipt
          JOIN cookie_staff.service_assignments sa ON sa.tenant_id=receipt.tenant_id
            AND sa.staff_id=receipt.staff_id AND sa.location_id=receipt.location_id AND sa.service_id=receipt.service_id
          JOIN cookie_catalog.services s ON s.tenant_id=sa.tenant_id AND s.id=sa.service_id
         WHERE receipt.tenant_id=$1::uuid AND receipt.staff_id=$2::uuid AND receipt.location_id=$3::uuid
           AND receipt.grant_id=$4::uuid AND sa.active AND s.active
         ORDER BY sa.service_id LIMIT 1 FOR SHARE OF sa,s`,
        [tenantId,shift.staff_id,shift.location_id,grant!.id],
      );
      if (!placement.rowCount) reject("SHIFT_TARGET_UNAVAILABLE");
      const draft = await client.query(
        "SELECT 1 FROM cookie_scheduling.shift_draft_audit WHERE tenant_id=$1::uuid AND shift_id=$2::uuid AND operation=\'create\' LIMIT 1",
        [tenantId,shift.id],
      );
      if (!draft.rowCount) reject("SHIFT_NOT_FOUND");
    } else try {
      await assertMayPublish!(client, {
        tenantId,
        shiftId: shift.id,
        staffId: shift.staff_id,
        locationId: shift.location_id,
        startAt: shift.start_at.toISOString(),
        endAt: shift.end_at.toISOString(),
        actor: input.actor,
      });
    } catch {
      // Never expose administrative/entitlement policy internals to an API.
      throw new PublishShiftFailure("SHIFT_POLICY_DENIED");
    }

    // F1 conservative explicit rule: a staff member must not expose
    // overlapping availability across different Locations. Same-location
    // overlapping shifts remain allowed. F2 policy requires owner review.
    const conflict = await client.query(
      `SELECT id
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
          AND location_id<>$3::uuid AND active
          AND tstzrange(start_at, end_at, '[)')
              && tstzrange($4::timestamptz, $5::timestamptz, '[)')
        LIMIT 1`,
      [
        tenantId,
        shift.staff_id,
        shift.location_id,
        shift.start_at,
        shift.end_at,
      ],
    );
    if (conflict.rowCount) reject("SHIFT_CROSS_LOCATION_CONFLICT");

    const updated = await client.query(
      `UPDATE cookie_scheduling.shift_windows SET active=true
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND NOT active`,
      [tenantId, shift.id],
    );
    if (updated.rowCount !== 1) reject("SHIFT_ALREADY_ACTIVE");

    const receipt: PublishedShiftReceipt = {
      shiftId: shift.id,
      staffId: shift.staff_id,
      locationId: shift.location_id,
      startAt: shift.start_at.toISOString(),
      endAt: shift.end_at.toISOString(),
      active: true,
    };

    await client.query(
      `INSERT INTO cookie_scheduling.shift_publish_audit
         (tenant_id,id,shift_id,actor_identity_id,correlation_id,
          previous_active,next_active)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,false,true)`,
      [tenantId, randomUUID(), shift.id, actorId, input.actor.correlationId],
    );
    await enqueueOutbox(client, {
      tenantId,
      dedupeKey: `schedule.shift.published:${shift.id}`,
      topic: "schedule.shift.published",
      payload: {
        shiftId: shift.id,
        staffId: shift.staff_id,
        locationId: shift.location_id,
      },
    });
    await client.query(
      `INSERT INTO cookie_scheduling.shift_publish_receipts
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

    if (staging) {
      await lockLiveStagingGrant(client, tenantId);
      const check = await client.query("SELECT 1 WHERE $1::timestamptz > clock_timestamp()", [shift.start_at]);
      if (!check.rowCount) reject("SHIFT_NOT_FUTURE");
    }
    if (ownsTransaction) await client.query("COMMIT");
    active = false;
    return receipt;
  } catch (error) {
    if (active && ownsTransaction) {
      await client.query("ROLLBACK").catch(() => { discard = true; });
    }
    throw error;
  } finally {
    if (ownsTransaction) client.release(discard);
  }
}
