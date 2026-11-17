import { createHash, randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

/** StaffProfile is not a Cookie Identity and grants NO roles or client access. */
export interface CreateDraftStaffInput {
  readonly displayName: string;
  readonly positionTitle: string;
}

export interface StaffProfileRecord {
  readonly id: string;
  readonly displayName: string;
  readonly positionTitle: string | null;
  readonly active: boolean;
  readonly bookable: boolean;
  readonly createdAt: string;
}

export class StaffInputError extends Error {}
export class StaffReplayConflict extends Error {}

interface StaffRow extends QueryResultRow {
  id: string;
  display_name: string;
  position_title: string | null;
  active: boolean;
  bookable: boolean;
  created_at: Date;
}

interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  staff_id: string;
}

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const STAFF_COLUMNS =
  "id::text, display_name, position_title, active, bookable, created_at";

function cleanName(value: unknown, limit: number): string {
  if (typeof value !== "string") throw new StaffInputError("invalid type");
  const name = value.normalize("NFC").trim();
  if (
    !name ||
    [...name].length > limit ||
    /\p{Cc}/u.test(name)
  ) {
    throw new StaffInputError("invalid name");
  }
  return name;
}

/** Strict shape: never allow clients to set bookable, staff identity or roles. */
export function validateDraftStaff(input: unknown): CreateDraftStaffInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StaffInputError("invalid input");
  }
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, "displayName") ||
    !Object.hasOwn(body, "positionTitle")
  ) {
    throw new StaffInputError("invalid fields");
  }
  return {
    displayName: cleanName(body.displayName, 200),
    positionTitle: cleanName(body.positionTitle, 100),
  };
}

function toRecord(row: StaffRow): StaffProfileRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    positionTitle: row.position_title,
    active: row.active,
    bookable: row.bookable,
    createdAt: row.created_at.toISOString(),
  };
}

/** Called only under a verified session and transaction-scoped permission. */
export async function listTenantStaffProfiles(
  client: PoolClient,
  tenantId: string,
): Promise<StaffProfileRecord[]> {
  const saved = await client.query<StaffRow>(
    `SELECT ${STAFF_COLUMNS} FROM cookie_staff.staff_profiles
       WHERE tenant_id=$1::uuid ORDER BY created_at, id LIMIT 101`,
    [tenantId],
  );
  if (saved.rows.length > 100) {
    throw new Error("StaffProfile list exceeds F1 boundary");
  }
  return saved.rows.map(toRecord);
}

/**
 * Durable exact replay for one (tenant, verified actor, key). The transaction
 * must hold requireTenantPermission locks across every write until COMMIT.
 * New staff have no login, role, location/service assignment or shifts.
 */
export async function createTenantDraftStaff(
  client: PoolClient,
  tenantId: string,
  actorIdentityId: string,
  idempotencyKey: string,
  input: CreateDraftStaffInput,
): Promise<{ staff: StaffProfileRecord; replayed: boolean }> {
  if (!KEY.test(idempotencyKey)) {
    throw new StaffInputError("invalid key");
  }
  const sha = createHash("sha256")
    .update(JSON.stringify([1, input.displayName, input.positionTitle]))
    .digest("hex");
  const scope = JSON.stringify([tenantId, actorIdentityId, idempotencyKey]);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [scope],
  );
  const receipt = await client.query<ReceiptRow>(
    `SELECT request_sha256, staff_id::text
       FROM cookie_staff.profile_create_receipts
      WHERE tenant_id=$1::uuid
        AND actor_identity_id=$2::uuid
        AND idempotency_key=$3`,
    [tenantId, actorIdentityId, idempotencyKey],
  );
  const existing = receipt.rows[0];
  if (existing && existing.request_sha256 !== sha) {
    throw new StaffReplayConflict("idempotency key reused");
  }
  const staffId = existing?.staff_id ?? randomUUID();
  if (!existing) {
    await client.query(
      `INSERT INTO cookie_staff.staff_profiles
       (tenant_id,id,display_name,position_title,active,bookable)
       VALUES($1::uuid,$2::uuid,$3,$4,true,false)`,
      [tenantId, staffId, input.displayName, input.positionTitle],
    );
    await client.query(
      `INSERT INTO cookie_staff.profile_create_receipts
       (tenant_id,actor_identity_id,idempotency_key,request_sha256,staff_id)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid)`,
      [tenantId, actorIdentityId, idempotencyKey, sha, staffId],
    );
  }
  const row = await client.query<StaffRow>(
    `SELECT ${STAFF_COLUMNS} FROM cookie_staff.staff_profiles
      WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, staffId],
  );
  if (!row.rows[0]) throw new Error("Created StaffProfile not found");
  return { staff: toRecord(row.rows[0]), replayed: Boolean(existing) };
}
