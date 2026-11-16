import { createHash, randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

/**
 * Catalog-owned SQL adapter. Authenticated actor/tenant and transaction-scoped
 * policy checks are supplied by the API composition root, never by HTTP JSON.
 */
export interface CreateDraftServiceInput {
  readonly displayName: string;
  readonly durationMinutes: number;
  readonly basePriceKopecks: number;
}

export interface ServiceRecord {
  readonly id: string;
  readonly displayName: string;
  readonly durationMinutes: number;
  readonly basePriceKopecks: number;
  readonly active: boolean;
  readonly createdAt: string;
}

export class CatalogInputError extends Error {}
export class CatalogReplayConflict extends Error {}

interface ServiceRow extends QueryResultRow {
  id: string;
  display_name: string;
  duration_minutes: number;
  base_price_kopecks: string;
  active: boolean;
  created_at: Date;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  service_id: string;
}

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const MAX_PRICE_KOPECKS = 999_999_999_999;

export function validateDraftService(input: unknown): CreateDraftServiceInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CatalogInputError("invalid input");
  }
  const values = input as Record<string, unknown>;
  if (
    Object.keys(values).length !== 3 ||
    !Object.hasOwn(values, "displayName") ||
    !Object.hasOwn(values, "durationMinutes") ||
    !Object.hasOwn(values, "basePriceKopecks") ||
    typeof values.displayName !== "string"
  ) {
    throw new CatalogInputError("invalid fields");
  }
  const name = values.displayName.normalize("NFC").trim();
  if (
    !name ||
    [...name].length > 200 ||
    /\p{Cc}/u.test(name) ||
    !Number.isInteger(values.durationMinutes) ||
    (values.durationMinutes as number) < 1 ||
    (values.durationMinutes as number) > 1440 ||
    !Number.isSafeInteger(values.basePriceKopecks) ||
    (values.basePriceKopecks as number) < 0 ||
    (values.basePriceKopecks as number) > MAX_PRICE_KOPECKS
  ) {
    throw new CatalogInputError("invalid values");
  }
  return {
    displayName: name,
    durationMinutes: values.durationMinutes as number,
    basePriceKopecks: values.basePriceKopecks as number,
  };
}

function mapService(row: ServiceRow): ServiceRecord {
  const amount = Number(row.base_price_kopecks);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Database price is outside safe view range");
  }
  return {
    id: row.id,
    displayName: row.display_name,
    durationMinutes: row.duration_minutes,
    basePriceKopecks: amount,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

const SELECT_FIELDS = `id::text, display_name, duration_minutes,
  base_price_kopecks::text, active, created_at`;

/** Stable, bounded tenant list; never silently return a truncated catalog. */
export async function listTenantServices(
  client: PoolClient,
  tenantId: string,
): Promise<ServiceRecord[]> {
  const result = await client.query<ServiceRow>(
    `SELECT ${SELECT_FIELDS} FROM cookie_catalog.services
      WHERE tenant_id=$1::uuid ORDER BY created_at, id LIMIT 101`,
    [tenantId],
  );
  if (result.rows.length > 100) throw new Error("Service catalog exceeds F1 limit");
  return result.rows.map(mapService);
}

/**
 * Must run inside the SAME open transaction as requireTenantPermission.
 * The advisory lock serializes same-actor/key requests before reading receipt.
 * DB uniqueness is the final arbiter; changed payload with same key is a 409.
 * This never activates/publishes a service for bookings.
 */
export async function createTenantDraftService(
  client: PoolClient,
  tenantId: string,
  actorIdentityId: string,
  key: string,
  input: CreateDraftServiceInput,
): Promise<{ service: ServiceRecord; replayed: boolean }> {
  if (!KEY.test(key)) throw new CatalogInputError("invalid idempotency key");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        1,
        input.displayName,
        input.durationMinutes,
        input.basePriceKopecks,
      ]),
    )
    .digest("hex");

  const scope = JSON.stringify([tenantId, actorIdentityId, key]);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [scope],
  );
  const existing = await client.query<ReceiptRow>(
    `SELECT request_sha256, service_id::text
       FROM cookie_catalog.service_create_receipts
      WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3`,
    [tenantId, actorIdentityId, key],
  );

  if (existing.rows[0] && existing.rows[0].request_sha256 !== hash) {
    throw new CatalogReplayConflict("idempotency key reused with another request");
  }
  const serviceId = existing.rows[0]?.service_id ?? randomUUID();
  if (!existing.rows[0]) {
    await client.query(
      `INSERT INTO cookie_catalog.services
       (tenant_id,id,display_name,duration_minutes,base_price_kopecks,active)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::bigint,false)`,
      [tenantId, serviceId, input.displayName, input.durationMinutes, input.basePriceKopecks],
    );
    await client.query(
      `INSERT INTO cookie_catalog.service_create_receipts
       (tenant_id,actor_identity_id,idempotency_key,request_sha256,service_id)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid)`,
      [tenantId, actorIdentityId, key, hash, serviceId],
    );
  }
  const saved = await client.query<ServiceRow>(
    `SELECT ${SELECT_FIELDS} FROM cookie_catalog.services
      WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, serviceId],
  );
  if (!saved.rows[0]) throw new Error("Stored service not found");
  return { service: mapService(saved.rows[0]), replayed: Boolean(existing.rows[0]) };
}
