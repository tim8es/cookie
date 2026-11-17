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
  readonly revision: number;
}

export class CatalogInputError extends Error {}
export class CatalogReplayConflict extends Error {}
export class CatalogRevisionConflict extends Error {}
export class CatalogDraftUnavailable extends Error {}

interface ServiceRow extends QueryResultRow {
  id: string;
  display_name: string;
  duration_minutes: number;
  base_price_kopecks: string;
  active: boolean;
  created_at: Date;
  draft_revision: number;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  service_id: string;
  result_service: ServiceRecord;
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
    revision: row.draft_revision,
  };
}

const SELECT_FIELDS = `id::text, display_name, duration_minutes,
  base_price_kopecks::text, active, created_at, draft_revision`;

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
  if (result.rows.length > 100)
    throw new Error("Service catalog exceeds F1 limit");
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
    `SELECT request_sha256, service_id::text, result_service
       FROM cookie_catalog.service_create_receipts
      WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3`,
    [tenantId, actorIdentityId, key],
  );

  if (existing.rows[0] && existing.rows[0].request_sha256 !== hash) {
    throw new CatalogReplayConflict(
      "idempotency key reused with another request",
    );
  }
  if (existing.rows[0]) {
    return { service: existing.rows[0].result_service, replayed: true };
  }
  const serviceId = randomUUID();
  const inserted = await client.query<ServiceRow>(
    `INSERT INTO cookie_catalog.services
       (tenant_id,id,display_name,duration_minutes,base_price_kopecks,active)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::bigint,false)
       RETURNING ${SELECT_FIELDS}`,
    [
      tenantId,
      serviceId,
      input.displayName,
      input.durationMinutes,
      input.basePriceKopecks,
    ],
  );
  if (!inserted.rows[0]) throw new Error("Stored service not found");
  const service = mapService(inserted.rows[0]);
  await client.query(
    `INSERT INTO cookie_catalog.service_create_receipts
       (tenant_id,actor_identity_id,idempotency_key,request_sha256,service_id,result_service)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb)`,
    [tenantId, actorIdentityId, key, hash, serviceId, JSON.stringify(service)],
  );
  return { service, replayed: false };
}

export interface EditDraftServiceInput extends CreateDraftServiceInput {
  readonly expectedRevision: number;
}

export function validateEditDraftService(
  input: unknown,
): EditDraftServiceInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CatalogInputError("invalid edit");
  }
  const { expectedRevision, ...fields } = input as Record<string, unknown>;
  if (
    !Number.isSafeInteger(expectedRevision) ||
    (expectedRevision as number) < 0 ||
    (expectedRevision as number) >= 2147483647
  ) {
    throw new CatalogInputError("invalid revision");
  }
  return {
    ...validateDraftService(fields),
    expectedRevision: expectedRevision as number,
  };
}

/** The protected API owns the transaction and current permission checks.
 * Only a currently inactive, API-originated draft without active assignments or booking history is eligible. No price snapshot or
 * assignment is modified. The edit receipt survives later revisions.
 */
export async function editTenantDraftService(
  client: PoolClient,
  tenantId: string,
  actorIdentityId: string,
  serviceId: string,
  key: string,
  input: EditDraftServiceInput,
): Promise<ServiceRecord> {
  if (!KEY.test(key)) throw new CatalogInputError("invalid key");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        1,
        serviceId,
        input.expectedRevision,
        input.displayName,
        input.durationMinutes,
        input.basePriceKopecks,
      ]),
    )
    .digest("hex");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [JSON.stringify([tenantId, actorIdentityId, "catalog.service.edit", key])],
  );
  const existing = await client.query<ReceiptRow>(
    `SELECT request_sha256,service_id::text,result_service
       FROM cookie_catalog.service_edit_receipts
      WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3`,
    [tenantId, actorIdentityId, key],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].request_sha256 !== hash)
      throw new CatalogReplayConflict();
    return existing.rows[0].result_service;
  }

  // Service row serializes independent edits and future publication. This
  // command cannot touch active services or rows with booking history.
  const current = await client.query<ServiceRow>(
    `SELECT ${SELECT_FIELDS} FROM cookie_catalog.services
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
    [tenantId, serviceId],
  );
  const row = current.rows[0];
  if (!row || row.active) throw new CatalogDraftUnavailable();
  const eligibility = await client.query<{ eligible: boolean }>(
    `SELECT EXISTS (
         SELECT 1 FROM cookie_catalog.service_create_receipts
          WHERE tenant_id=$1::uuid AND service_id=$2::uuid
       ) AND NOT EXISTS (
         SELECT 1 FROM cookie_staff.service_assignments
          WHERE tenant_id=$1::uuid AND service_id=$2::uuid AND active
       ) AND NOT EXISTS (
         SELECT 1 FROM cookie_booking.bookings
          WHERE tenant_id=$1::uuid AND service_id=$2::uuid
       ) AS eligible`,
    [tenantId, serviceId],
  );
  if (!eligibility.rows[0]?.eligible) throw new CatalogDraftUnavailable();
  if (row.draft_revision !== input.expectedRevision)
    throw new CatalogRevisionConflict();
  const saved = await client.query<ServiceRow>(
    `UPDATE cookie_catalog.services
        SET display_name=$3,duration_minutes=$4,base_price_kopecks=$5::bigint,
            draft_revision=draft_revision+1
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND NOT active
        AND draft_revision=$6
      RETURNING ${SELECT_FIELDS}`,
    [
      tenantId,
      serviceId,
      input.displayName,
      input.durationMinutes,
      input.basePriceKopecks,
      input.expectedRevision,
    ],
  );
  if (!saved.rows[0]) throw new CatalogRevisionConflict();
  const service = mapService(saved.rows[0]);
  await client.query(
    `INSERT INTO cookie_catalog.service_edit_receipts
       (tenant_id,actor_identity_id,idempotency_key,request_sha256,service_id,result_service)
       VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb)`,
    [tenantId, actorIdentityId, key, hash, serviceId, JSON.stringify(service)],
  );
  return service;
}
