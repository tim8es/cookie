import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

export interface DraftStaffInput {
  readonly displayName: string;
  /** Presentation-only job title, never an Identity role. */
  readonly positionTitle: string;
  readonly locationId: string;
  readonly serviceId: string;
}
export interface StaffLocationAssignment {
  readonly locationId: string;
  readonly serviceIds: readonly string[];
}
export interface StaffRecord {
  readonly id: string;
  readonly displayName: string;
  readonly positionTitle: string;
  readonly active: boolean;
  readonly bookable: boolean;
  readonly createdAt: string;
  readonly assignments: readonly StaffLocationAssignment[];
}
export interface StaffLocation {
  readonly id: string;
  readonly displayName: string;
}
export class StaffInputError extends Error {}
export class StaffReferenceNotFound extends Error {}
export class StaffReplayConflict extends Error {}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

function canonicalText(
  value: unknown,
  max: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new StaffInputError("invalid text");
  const normalized = value.normalize("NFC").trim();
  if (
    (!allowEmpty && !normalized) ||
    [...normalized].length > max ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new StaffInputError("invalid text");
  }
  return normalized;
}

export function validateStaffDraft(raw: unknown): DraftStaffInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StaffInputError("invalid input");
  }
  const data = raw as Record<string, unknown>;
  if (
    Object.keys(data).length !== 4 ||
    !Object.hasOwn(data, "displayName") ||
    !Object.hasOwn(data, "positionTitle") ||
    !Object.hasOwn(data, "locationId") ||
    !Object.hasOwn(data, "serviceId") ||
    typeof data.locationId !== "string" ||
    typeof data.serviceId !== "string" ||
    !UUID.test(data.locationId) ||
    !UUID.test(data.serviceId)
  )
    throw new StaffInputError("invalid fields");
  return {
    displayName: canonicalText(data.displayName, 200),
    positionTitle: canonicalText(data.positionTitle, 80, true),
    locationId: data.locationId,
    serviceId: data.serviceId,
  };
}

interface ProfileRow extends QueryResultRow {
  readonly id: string;
  readonly display_name: string;
  readonly position_title: string;
  readonly active: boolean;
  readonly bookable: boolean;
  readonly created_at: Date;
}
interface AssignmentRow extends QueryResultRow {
  readonly staff_id: string;
  readonly location_id: string;
  readonly service_id: string | null;
}
interface LocationRow extends QueryResultRow {
  readonly id: string;
  readonly display_name: string;
}
interface ReceiptRow extends QueryResultRow {
  readonly request_sha256: string;
  readonly staff_id: string;
}

function mapStaff(
  row: ProfileRow,
  assignments: readonly StaffLocationAssignment[],
): StaffRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    positionTitle: row.position_title,
    active: row.active,
    bookable: row.bookable,
    createdAt: row.created_at.toISOString(),
    assignments,
  };
}

async function readAssignments(
  client: PoolClient,
  tenantId: string,
  staffIds: readonly string[],
): Promise<Map<string, StaffLocationAssignment[]>> {
  const collected = new Map<string, Map<string, string[]>>();
  if (staffIds.length === 0) return new Map();
  const rows = await client.query<AssignmentRow>(
    `SELECT la.staff_id::text, la.location_id::text, sa.service_id::text
       FROM cookie_staff.location_assignments la
       LEFT JOIN cookie_staff.service_assignments sa
         ON sa.tenant_id=la.tenant_id
        AND sa.staff_id=la.staff_id AND sa.location_id=la.location_id
      WHERE la.tenant_id=$1::uuid AND la.staff_id = ANY($2::uuid[])
      ORDER BY la.staff_id,la.location_id,sa.service_id LIMIT 1001`,
    [tenantId, [...staffIds]],
  );
  if (rows.rows.length > 1000)
    throw new Error("Staff assignments exceed F1 limit");
  for (const row of rows.rows) {
    if (!collected.has(row.staff_id)) collected.set(row.staff_id, new Map());
    const byLocation = collected.get(row.staff_id)!;
    if (!byLocation.has(row.location_id)) byLocation.set(row.location_id, []);
    if (row.service_id) byLocation.get(row.location_id)!.push(row.service_id);
  }
  return new Map(
    [...collected].map(([id, perLocation]) => [
      id,
      [...perLocation].map(([locationId, serviceIds]) => ({
        locationId,
        serviceIds,
      })),
    ]),
  );
}

/** Tenant-scoped directory including inactive assignments and draft staff. */
export async function listTenantStaff(
  client: PoolClient,
  tenantId: string,
): Promise<{ staff: StaffRecord[]; locations: StaffLocation[] }> {
  const profiles = await client.query<ProfileRow>(
    `SELECT id::text,display_name,position_title,active,bookable,created_at
       FROM cookie_staff.staff_profiles
      WHERE tenant_id=$1::uuid ORDER BY created_at,id LIMIT 101`,
    [tenantId],
  );
  const locationRows = await client.query<LocationRow>(
    `SELECT id::text,display_name FROM cookie_tenancy.locations
      WHERE tenant_id=$1::uuid ORDER BY display_name,id LIMIT 101`,
    [tenantId],
  );
  if (profiles.rows.length > 100 || locationRows.rows.length > 100) {
    throw new Error("Staff directory exceeds F1 limit");
  }
  const assignments = await readAssignments(
    client,
    tenantId,
    profiles.rows.map((row) => row.id),
  );
  return {
    staff: profiles.rows.map((row) =>
      mapStaff(row, assignments.get(row.id) ?? []),
    ),
    locations: locationRows.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
    })),
  };
}

/** All writes and replay receipt atomically join the API caller's policy check. */
export async function createTenantDraftStaff(
  client: PoolClient,
  tenantId: string,
  actorIdentityId: string,
  key: string,
  draft: DraftStaffInput,
): Promise<{ staff: StaffRecord; replayed: boolean }> {
  if (!KEY.test(key)) throw new StaffInputError("invalid idempotency key");
  const sha = createHash("sha256")
    .update(
      JSON.stringify([
        1,
        draft.displayName,
        draft.positionTitle,
        draft.locationId,
        draft.serviceId,
      ]),
    )
    .digest("hex");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [JSON.stringify([tenantId, actorIdentityId, key])],
  );
  const existing = await client.query<ReceiptRow>(
    `SELECT request_sha256,staff_id::text FROM cookie_staff.staff_create_receipts
      WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3`,
    [tenantId, actorIdentityId, key],
  );
  if (existing.rows[0] && existing.rows[0].request_sha256 !== sha) {
    throw new StaffReplayConflict("key used with changed payload");
  }
  const staffId = existing.rows[0]?.staff_id ?? randomUUID();
  if (!existing.rows[0]) {
    const location = await client.query(
      "SELECT id FROM cookie_tenancy.locations WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [tenantId, draft.locationId],
    );
    const service = await client.query(
      "SELECT id FROM cookie_catalog.services WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [tenantId, draft.serviceId],
    );
    if (location.rowCount !== 1 || service.rowCount !== 1) {
      throw new StaffReferenceNotFound("unknown location or service");
    }
    await client.query(
      `INSERT INTO cookie_staff.staff_profiles
         (tenant_id,id,display_name,position_title,active,bookable)
       VALUES ($1::uuid,$2::uuid,$3,$4,true,false)`,
      [tenantId, staffId, draft.displayName, draft.positionTitle],
    );
    await client.query(
      `INSERT INTO cookie_staff.location_assignments
         (tenant_id,staff_id,location_id,active)
       VALUES ($1::uuid,$2::uuid,$3::uuid,false)`,
      [tenantId, staffId, draft.locationId],
    );
    await client.query(
      `INSERT INTO cookie_staff.service_assignments
         (tenant_id,staff_id,location_id,service_id,active)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,false)`,
      [tenantId, staffId, draft.locationId, draft.serviceId],
    );
    await client.query(
      `INSERT INTO cookie_staff.staff_create_receipts
         (tenant_id,actor_identity_id,idempotency_key,request_sha256,staff_id)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid)`,
      [tenantId, actorIdentityId, key, sha, staffId],
    );
  }
  const saved = await client.query<ProfileRow>(
    `SELECT id::text,display_name,position_title,active,bookable,created_at
       FROM cookie_staff.staff_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, staffId],
  );
  if (!saved.rows[0]) throw new Error("Committed staff profile missing");
  const assignments = await readAssignments(client, tenantId, [staffId]);
  return {
    staff: mapStaff(saved.rows[0], assignments.get(staffId) ?? []),
    replayed: Boolean(existing.rows[0]),
  };
}
