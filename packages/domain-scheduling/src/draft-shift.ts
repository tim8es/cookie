import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { enqueueOutbox } from "../../platform-db/src/outbox.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";
import { resolveLocalMinute, validateLocalMinute } from "./local-minute.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
const MAX_INTERVAL_MS = 48 * 60 * 60 * 1000;

export type DraftShiftFailureCode =
  | "INVALID_DRAFT_COMMAND"
  | "DRAFT_TARGET_UNAVAILABLE"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_NOT_EDITABLE"
  | "DRAFT_STALE_REVISION"
  | "DRAFT_UNCHANGED"
  | "DRAFT_POLICY_DENIED"
  | "DRAFT_KEY_REUSED"
  | "DRAFT_LOCAL_TIME_INVALID";

export class DraftShiftFailure extends Error {
  constructor(readonly code: DraftShiftFailureCode) {
    super(code);
    this.name = "DraftShiftFailure";
  }
}

interface DraftCommandBase {
  readonly actor: TrustedActor;
  readonly idempotencyKey: string;
  readonly startAt: string;
  readonly endAt: string;
}

/** Future draft only; staff/location/UTC instants are explicit at creation. */
export interface InternalCreateShiftDraft extends DraftCommandBase {
  readonly staffId: string;
  readonly locationId: string;
}

/** Only interval edits are supported; assignment cannot change in-place. */
export interface InternalEditShiftDraft extends DraftCommandBase {
  readonly shiftId: string;
  readonly expectedRevision: number;
}

export interface ShiftDraftReceipt {
  readonly shiftId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly active: false;
  readonly revision: number;
}

type DraftOperation = "create" | "edit";

/** Mandatory trusted F1 policy port, not wired to a real administrator API. */
export type AssertMayChangeDraft = (
  client: PoolClient,
  context: {
    readonly operation: DraftOperation;
    readonly actor: TrustedActor;
    readonly shiftId?: string;
    readonly staffId: string;
    readonly locationId: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly previousStartAt?: string;
    readonly previousEndAt?: string;
    readonly previousRevision?: number;
  },
) => Promise<void>;

interface DraftRow extends QueryResultRow {
  id: string;
  staff_id: string;
  location_id: string;
  active: boolean;
  start_at: Date;
  end_at: Date;
  draft_revision: number;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  result: ShiftDraftReceipt;
}
interface TargetRow extends QueryResultRow {
  time_zone: string | null;
}

function fail(code: DraftShiftFailureCode): never {
  throw new DraftShiftFailure(code);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateBase(
  input: Pick<DraftCommandBase, "actor" | "idempotencyKey">,
): void {
  if (
    !input ||
    !input.actor ||
    !UUID.test(input.actor.tenantId) ||
    !UUID.test(input.actor.identityId) ||
    typeof input.actor.correlationId !== "string" ||
    input.actor.correlationId.length < 1 ||
    input.actor.correlationId.length > 128 ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128
  ) {
    fail("INVALID_DRAFT_COMMAND");
  }
}

function parseUtcMinute(value: string): string {
  if (typeof value !== "string" || !UTC_MINUTE.test(value)) {
    return fail("INVALID_DRAFT_COMMAND");
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    return fail("INVALID_DRAFT_COMMAND");
  }
  return new Date(timestamp).toISOString();
}

function parseRange(input: DraftCommandBase): {
  startAt: string;
  endAt: string;
} {
  const startAt = parseUtcMinute(input.startAt);
  const endAt = parseUtcMinute(input.endAt);
  const delta = Date.parse(endAt) - Date.parse(startAt);
  if (delta <= 0 || delta > MAX_INTERVAL_MS) {
    fail("INVALID_DRAFT_COMMAND");
  }
  return { startAt, endAt };
}

async function assertFuture(
  client: PoolClient,
  startAt: string,
): Promise<void> {
  const time = await client.query<{ now: Date }>(
    "SELECT clock_timestamp() AS now",
  );
  if (Date.parse(startAt) <= (time.rows[0]?.now.getTime() ?? Infinity)) {
    fail("DRAFT_TARGET_UNAVAILABLE");
  }
}

async function assertTarget(
  client: PoolClient,
  tenantId: string,
  staffId: string,
  locationId: string,
  allowUnpublishedAssignment = false,
): Promise<string> {
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
        AND staff.active
        AND (assignment.active OR ($4::boolean AND NOT staff.bookable))
      FOR SHARE OF assignment, location`,
    [tenantId, staffId, locationId, allowUnpublishedAssignment],
  );
  const zone = target.rows[0]?.time_zone;
  if (!zone) fail("DRAFT_TARGET_UNAVAILABLE");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
  } catch {
    fail("DRAFT_TARGET_UNAVAILABLE");
  }
  return zone;
}

async function authorize(
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

async function receiptFor(
  client: PoolClient,
  actor: TrustedActor,
  operation: DraftOperation,
  keyHash: string,
  requestHash: string,
): Promise<ShiftDraftReceipt | null> {
  // Lock order: tenant/staff row, then shift row (edit), then advisory key.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [
      JSON.stringify([
        actor.tenantId,
        actor.identityId,
        `schedule.shift.draft.${operation}`,
        keyHash,
      ]),
    ],
  );
  const previous = await client.query<ReceiptRow>(
    `SELECT request_sha256, result
       FROM cookie_scheduling.shift_draft_receipts
      WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
        AND operation=$3 AND key_sha256=$4`,
    [actor.tenantId, actor.identityId, operation, keyHash],
  );
  const old = previous.rows[0];
  if (!old) return null;
  if (old.request_sha256 !== requestHash) fail("DRAFT_KEY_REUSED");
  return old.result;
}

async function assertPolicy(
  client: PoolClient,
  policy: AssertMayChangeDraft,
  context: Parameters<AssertMayChangeDraft>[1],
): Promise<void> {
  try {
    await policy(client, context);
  } catch {
    fail("DRAFT_POLICY_DENIED");
  }
}

async function persistSuccess(
  client: PoolClient,
  input: {
    actor: TrustedActor;
    operation: DraftOperation;
    keyHash: string;
    requestHash: string;
    receipt: ShiftDraftReceipt;
    oldStartAt?: string;
    oldEndAt?: string;
    oldRevision?: number;
  },
): Promise<void> {
  const { actor, receipt, operation } = input;
  await client.query(
    `INSERT INTO cookie_scheduling.shift_draft_audit
       (tenant_id,id,shift_id,actor_identity_id,correlation_id,
        operation,old_start_at,old_end_at,new_start_at,new_end_at,
        old_revision,new_revision)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,
             $7::timestamptz,$8::timestamptz,$9::timestamptz,
             $10::timestamptz,$11,$12)`,
    [
      actor.tenantId,
      randomUUID(),
      receipt.shiftId,
      actor.identityId,
      actor.correlationId,
      operation,
      input.oldStartAt ?? null,
      input.oldEndAt ?? null,
      receipt.startAt,
      receipt.endAt,
      input.oldRevision ?? null,
      receipt.revision,
    ],
  );
  await enqueueOutbox(client, {
    tenantId: actor.tenantId,
    dedupeKey: `schedule.shift.draft.${operation}:${receipt.shiftId}:${receipt.revision}`,
    topic: `schedule.shift.draft.${operation === "create" ? "created" : "edited"}`,
    payload: {
      shiftId: receipt.shiftId,
      staffId: receipt.staffId,
      locationId: receipt.locationId,
      revision: receipt.revision,
    },
  });
  await client.query(
    `INSERT INTO cookie_scheduling.shift_draft_receipts
       (tenant_id,actor_identity_id,operation,key_sha256,request_sha256,
        shift_id,result)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb)`,
    [
      actor.tenantId,
      actor.identityId,
      operation,
      input.keyHash,
      input.requestHash,
      receipt.shiftId,
      JSON.stringify(receipt),
    ],
  );
}

/** Owner-only unpublished planning; local times are resolved using locked Location IANA data. */
export interface OwnerShiftPlanInput {
  readonly actor: TrustedActor;
  readonly idempotencyKey: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly startLocal: string;
  readonly endLocal: string;
}

type CreateMode =
  | {
      readonly kind: "standard";
      readonly range: { startAt: string; endAt: string };
      readonly policy: AssertMayChangeDraft;
    }
  | {
      readonly kind: "owner-plan";
      readonly startLocal: string;
      readonly endLocal: string;
    };

export async function createShiftDraftInternal(
  pool: Pool,
  input: InternalCreateShiftDraft,
  assertMayChange: AssertMayChangeDraft,
  transactionClient?: PoolClient,
): Promise<ShiftDraftReceipt> {
  validateBase(input);
  if (
    !UUID.test(input.staffId) ||
    !UUID.test(input.locationId) ||
    typeof assertMayChange !== "function"
  ) {
    fail("INVALID_DRAFT_COMMAND");
  }
  const result = await createShiftDraft(
    pool,
    input,
    { kind: "standard", range: parseRange(input), policy: assertMayChange },
    transactionClient,
  );
  return result.receipt;
}

/**
 * The genuine owner can plan a shift for an existing configured assignment
 * before publication. Does not turn on the assignment, Staff.bookable, or
 * Service.active. This is NOT the admin/staff edit/approval command.
 */
export async function createOwnerShiftPlan(
  pool: Pool,
  input: OwnerShiftPlanInput,
): Promise<{ receipt: ShiftDraftReceipt; replayed: boolean }> {
  validateBase(input);
  if (!UUID.test(input.staffId) || !UUID.test(input.locationId)) {
    fail("INVALID_DRAFT_COMMAND");
  }
  try {
    validateLocalMinute(input.startLocal);
    validateLocalMinute(input.endLocal);
  } catch {
    fail("DRAFT_LOCAL_TIME_INVALID");
  }
  return createShiftDraft(pool, input, {
    kind: "owner-plan",
    startLocal: input.startLocal,
    endLocal: input.endLocal,
  });
}

async function createShiftDraft(
  pool: Pool,
  input: Pick<
    OwnerShiftPlanInput,
    "actor" | "idempotencyKey" | "staffId" | "locationId"
  >,
  mode: CreateMode,
  transactionClient?: PoolClient,
): Promise<{ receipt: ShiftDraftReceipt; replayed: boolean }> {
  const tenantId = input.actor.tenantId;
  const keyHash = digest(input.idempotencyKey);
  // Preserve historical request fingerprints for existing standard commands.
  const requestHash = digest(
    JSON.stringify(
      mode.kind === "standard"
        ? [
            input.staffId,
            input.locationId,
            mode.range.startAt,
            mode.range.endAt,
          ]
        : [
            "owner-plan-v1",
            input.staffId,
            input.locationId,
            mode.startLocal,
            mode.endLocal,
          ],
    ),
  );
  const client = transactionClient ?? (await pool.connect());
  const ownsTransaction = transactionClient === undefined;
  let active = false;
  try {
    if (ownsTransaction) await client.query("BEGIN");
    active = true;

    // Preserve the shared Staff-first mutation lock order. The planning
    // permission is deliberately owner-only, not a synthetic approval callback.
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.staffId],
    );
    if (mode.kind === "owner-plan") {
      await requireTenantPermission(
        client,
        input.actor,
        {
          kind: "schedule",
          tenantId,
          staffProfileId: input.staffId,
          locationId: input.locationId,
        },
        "schedule.shift.plan.create",
      );
    }
    if (staff.rowCount !== 1) fail("DRAFT_TARGET_UNAVAILABLE");
    const timeZone = await assertTarget(
      client,
      tenantId,
      input.staffId,
      input.locationId,
      mode.kind === "owner-plan",
    );
    if (mode.kind === "standard") {
      await authorize(client, input.actor, input.staffId, input.locationId);
    }

    const previous = await receiptFor(
      client,
      input.actor,
      "create",
      keyHash,
      requestHash,
    );
    if (previous) {
      if (ownsTransaction) await client.query("COMMIT");
      active = false;
      return { receipt: previous, replayed: true };
    }

    let range: { startAt: string; endAt: string };
    if (mode.kind === "standard") {
      range = mode.range;
    } else {
      try {
        const startAt = resolveLocalMinute(mode.startLocal, timeZone);
        const endAt = resolveLocalMinute(mode.endLocal, timeZone);
        const delta = Date.parse(endAt) - Date.parse(startAt);
        if (delta <= 0 || delta > MAX_INTERVAL_MS)
          fail("DRAFT_LOCAL_TIME_INVALID");
        range = { startAt, endAt };
      } catch {
        fail("DRAFT_LOCAL_TIME_INVALID");
      }
    }
    const { startAt, endAt } = range;
    await assertFuture(client, startAt);
    if (mode.kind === "standard") {
      await assertPolicy(client, mode.policy, {
        operation: "create",
        actor: input.actor,
        staffId: input.staffId,
        locationId: input.locationId,
        startAt,
        endAt,
      });
    }

    const shiftId = randomUUID();
    await client.query(
      `INSERT INTO cookie_scheduling.shift_windows
        (tenant_id,id,staff_id,location_id,start_at,end_at,
         active,draft_revision)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,
               $5::timestamptz,$6::timestamptz,false,0)`,
      [tenantId, shiftId, input.staffId, input.locationId, startAt, endAt],
    );
    const receipt: ShiftDraftReceipt = {
      shiftId,
      staffId: input.staffId,
      locationId: input.locationId,
      startAt,
      endAt,
      active: false,
      revision: 0,
    };
    await persistSuccess(client, {
      actor: input.actor,
      operation: "create",
      keyHash,
      requestHash,
      receipt,
    });
    if (ownsTransaction) await client.query("COMMIT");
    active = false;
    return { receipt, replayed: false };
  } catch (error) {
    if (active && ownsTransaction) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/**
 * INTERNAL F1: edit only drafts created by this controlled command path.
 * Revision is optimistic: distinct-key concurrent edits cannot last-write-win.
 * Legacy inactive shifts, published or disabled shifts are never edited.
 */
export async function editShiftDraftInternal(
  pool: Pool,
  input: InternalEditShiftDraft,
  assertMayChange: AssertMayChangeDraft,
  /** Trusted composition: caller owns BEGIN/COMMIT/ROLLBACK and release. */
  transactionClient?: PoolClient,
): Promise<ShiftDraftReceipt> {
  validateBase(input);
  if (
    !UUID.test(input.shiftId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    typeof assertMayChange !== "function"
  ) {
    fail("INVALID_DRAFT_COMMAND");
  }
  const { startAt, endAt } = parseRange(input);
  const tenantId = input.actor.tenantId;
  const keyHash = digest(input.idempotencyKey);
  const requestHash = digest(
    JSON.stringify([input.shiftId, input.expectedRevision, startAt, endAt]),
  );
  const client = transactionClient ?? (await pool.connect());
  const ownsTransaction = transactionClient === undefined;
  let active = false;
  try {
    if (ownsTransaction) await client.query("BEGIN");
    active = true;

    // Immutable staff/location are resolved before the staff lock.
    const reference = await client.query<DraftRow>(
      `SELECT staff_id::text,location_id::text
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, input.shiftId],
    );
    const meta = reference.rows[0];
    if (!meta) fail("DRAFT_NOT_FOUND");
    const staff = await client.query(
      `SELECT id FROM cookie_staff.staff_profiles
         WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, meta.staff_id],
    );
    if (staff.rowCount !== 1) fail("DRAFT_NOT_FOUND");

    const current = await client.query<DraftRow>(
      `SELECT id::text,staff_id::text,location_id::text,
              start_at,end_at,active,draft_revision
         FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
      [tenantId, input.shiftId],
    );
    const shift = current.rows[0];
    if (
      !shift ||
      shift.staff_id !== meta.staff_id ||
      shift.location_id !== meta.location_id
    ) {
      fail("DRAFT_NOT_FOUND");
    }

    await assertTarget(client, tenantId, shift.staff_id, shift.location_id);
    await authorize(client, input.actor, shift.staff_id, shift.location_id);
    const previous = await receiptFor(
      client,
      input.actor,
      "edit",
      keyHash,
      requestHash,
    );
    if (previous) {
      if (ownsTransaction) await client.query("COMMIT");
      active = false;
      return previous;
    }

    if (shift.active) fail("DRAFT_NOT_EDITABLE");
    // A legacy inactive row is ambiguous: only audited F1-created drafts
    // are safe to edit. A disabled or formerly published shift stays immutable.
    const provenance = await client.query(
      `SELECT id FROM cookie_scheduling.shift_draft_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
          AND operation='create' LIMIT 1`,
      [tenantId, shift.id],
    );
    const historical = await client.query(
      `SELECT 1 FROM cookie_scheduling.shift_publish_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
       UNION ALL
       SELECT 1 FROM cookie_scheduling.shift_disable_audit
        WHERE tenant_id=$1::uuid AND shift_id=$2::uuid LIMIT 1`,
      [tenantId, shift.id],
    );
    if (!provenance.rowCount || historical.rowCount) {
      fail("DRAFT_NOT_EDITABLE");
    }
    if (shift.draft_revision !== input.expectedRevision) {
      fail("DRAFT_STALE_REVISION");
    }

    const oldStartAt = shift.start_at.toISOString();
    const oldEndAt = shift.end_at.toISOString();
    if (oldStartAt === startAt && oldEndAt === endAt) {
      fail("DRAFT_UNCHANGED");
    }
    await assertFuture(client, oldStartAt);
    await assertFuture(client, startAt);
    await assertPolicy(client, assertMayChange, {
      operation: "edit",
      actor: input.actor,
      shiftId: shift.id,
      staffId: shift.staff_id,
      locationId: shift.location_id,
      startAt,
      endAt,
      previousStartAt: oldStartAt,
      previousEndAt: oldEndAt,
      previousRevision: shift.draft_revision,
    });

    const nextRevision = shift.draft_revision + 1;
    const updated = await client.query(
      `UPDATE cookie_scheduling.shift_windows
         SET start_at=$3::timestamptz,end_at=$4::timestamptz,
             draft_revision=$5
        WHERE tenant_id=$1::uuid AND id=$2::uuid
          AND NOT active AND draft_revision=$6`,
      [
        tenantId,
        shift.id,
        startAt,
        endAt,
        nextRevision,
        input.expectedRevision,
      ],
    );
    if (updated.rowCount !== 1) fail("DRAFT_STALE_REVISION");

    const receipt: ShiftDraftReceipt = {
      shiftId: shift.id,
      staffId: shift.staff_id,
      locationId: shift.location_id,
      startAt,
      endAt,
      active: false,
      revision: nextRevision,
    };
    await persistSuccess(client, {
      actor: input.actor,
      operation: "edit",
      keyHash,
      requestHash,
      receipt,
      oldStartAt,
      oldEndAt,
      oldRevision: shift.draft_revision,
    });
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
