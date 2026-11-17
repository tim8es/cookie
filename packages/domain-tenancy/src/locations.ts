import { createHash, randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

export interface CreateLocationInput {
  readonly displayName: string;
  readonly timeZone: string;
}

export interface TenantLocationRecord {
  readonly id: string;
  readonly displayName: string;
  readonly timeZone: string | null;
  readonly createdAt: string;
}

export class LocationInputError extends Error {}
export class LocationReplayConflict extends Error {}
export class LocationCapacityExceeded extends Error {}

interface LocationRow extends QueryResultRow {
  readonly id: string;
  readonly display_name: string;
  readonly time_zone: string | null;
  readonly created_at: Date;
}

interface ReceiptRow extends QueryResultRow {
  readonly request_sha256: string;
  readonly location_id: string;
}

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const ZONE = /^[A-Za-z][A-Za-z0-9_+./-]*$/;
const MAX_LOCATIONS = 100;
const SELECT_LOCATION = "id::text, display_name, time_zone, created_at";

export function validateCreateLocation(input: unknown): CreateLocationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocationInputError("invalid input");
  }
  const data = input as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    !Object.hasOwn(data, "displayName") ||
    !Object.hasOwn(data, "timeZone") ||
    typeof data.displayName !== "string" ||
    typeof data.timeZone !== "string"
  ) {
    throw new LocationInputError("invalid shape");
  }
  const displayName = data.displayName.normalize("NFC").trim();
  if (
    !displayName ||
    [...displayName].length > 200 ||
    /[\p{Cc}\p{Cs}]/u.test(displayName)
  ) {
    throw new LocationInputError("invalid name");
  }
  if (
    !data.timeZone ||
    data.timeZone.length > 128 ||
    !ZONE.test(data.timeZone)
  ) {
    throw new LocationInputError("invalid zone");
  }
  let timeZone: string;
  try {
    timeZone = new Intl.DateTimeFormat("en-US", {
      timeZone: data.timeZone,
    }).resolvedOptions().timeZone;
  } catch {
    throw new LocationInputError("unknown IANA zone");
  }
  if (!ZONE.test(timeZone)) {
    throw new LocationInputError("invalid normalized zone");
  }
  return { displayName, timeZone };
}

function record(row: LocationRow): TenantLocationRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    timeZone: row.time_zone,
    createdAt: row.created_at.toISOString(),
  };
}

/** Bounded tenant-only read; legacy locations with NULL zone stay visibly unconfigured. */
export async function listTenantLocations(
  client: PoolClient,
  tenantId: string,
): Promise<TenantLocationRecord[]> {
  const result = await client.query<LocationRow>(
    `SELECT ${SELECT_LOCATION} FROM cookie_tenancy.locations
      WHERE tenant_id=$1::uuid ORDER BY created_at, id LIMIT 101`,
    [tenantId],
  );
  if (result.rows.length > MAX_LOCATIONS) {
    throw new LocationCapacityExceeded("Location list exceeds F1 limit");
  }
  return result.rows.map(record);
}

/**
 * Caller holds current AuthN/AuthZ locks on the same PoolClient/transaction.
 * Advisory lock per tenant serializes all owner-side location creates, so the
 * 100-branch bound cannot be bypassed by parallel distinct idempotency keys.
 */
export async function createTenantLocation(
  client: PoolClient,
  tenantId: string,
  actorIdentityId: string,
  idempotencyKey: string,
  input: CreateLocationInput,
): Promise<{ location: TenantLocationRecord; replayed: boolean }> {
  if (!KEY.test(idempotencyKey)) {
    throw new LocationInputError("invalid idempotency key");
  }
  const requestHash = createHash("sha256")
    .update(JSON.stringify([1, input.displayName, input.timeZone]))
    .digest("hex");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",
    ["location.create:" + tenantId],
  );
  const receipt = await client.query<ReceiptRow>(
    `SELECT request_sha256, location_id::text
      FROM cookie_tenancy.location_create_receipts
      WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid
        AND idempotency_key=$3`,
    [tenantId, actorIdentityId, idempotencyKey],
  );
  const previous = receipt.rows[0];
  if (previous && previous.request_sha256 !== requestHash) {
    throw new LocationReplayConflict(
      "idempotency key used with changed request",
    );
  }
  const locationId = previous?.location_id ?? randomUUID();
  if (!previous) {
    const size = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM cookie_tenancy.locations WHERE tenant_id=$1::uuid",
      [tenantId],
    );
    if ((size.rows[0]?.count ?? MAX_LOCATIONS) >= MAX_LOCATIONS) {
      throw new LocationCapacityExceeded("Organization branch quota exceeded");
    }
    await client.query(
      `INSERT INTO cookie_tenancy.locations
         (tenant_id,id,display_name,time_zone)
       VALUES ($1::uuid,$2::uuid,$3,$4)`,
      [tenantId, locationId, input.displayName, input.timeZone],
    );
    await client.query(
      `INSERT INTO cookie_tenancy.location_create_receipts
         (tenant_id,actor_identity_id,idempotency_key,request_sha256,location_id)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid)`,
      [tenantId, actorIdentityId, idempotencyKey, requestHash, locationId],
    );
  }
  const saved = await client.query<LocationRow>(
    `SELECT ${SELECT_LOCATION} FROM cookie_tenancy.locations
      WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, locationId],
  );
  if (!saved.rows[0]) throw new Error("Committed location does not exist");
  return { location: record(saved.rows[0]), replayed: Boolean(previous) };
}
