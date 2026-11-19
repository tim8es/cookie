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
  /** Legacy clients omit this field; new forms supply an explicit value. */
  readonly postServiceBufferMinutes?: number;
}

export interface ServiceRecord {
  readonly id: string;
  readonly displayName: string;
  readonly durationMinutes: number;
  readonly basePriceKopecks: number;
  readonly postServiceBufferMinutes: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly revision: number;
}

// Pre-buffer receipts are immutable: never invent a historical value from
// the latest service row. New writes and all list reads include the field.
export type ServiceReceipt = Omit<ServiceRecord, "postServiceBufferMinutes"> & {
  readonly postServiceBufferMinutes?: number;
};

export class CatalogInputError extends Error {}
export class CatalogReplayConflict extends Error {}
export class CatalogCapacityReached extends Error {}
export class CatalogRevisionConflict extends Error {}
export class CatalogDraftUnavailable extends Error {}

interface ServiceRow extends QueryResultRow {
  id: string;
  display_name: string;
  duration_minutes: number;
  post_service_buffer_minutes: number;
  base_price_kopecks: string;
  active: boolean;
  created_at: Date;
  draft_revision: number;
  first_published_at: Date | null;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  service_id: string;
  result_service: ServiceReceipt;
}

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const MAX_PRICE_KOPECKS = 999_999_999_999;
const MAX_TENANT_SERVICES = 100;

export function validateDraftService(input: unknown): CreateDraftServiceInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CatalogInputError("invalid input");
  }
  const values = input as Record<string, unknown>;
  const hasBuffer = Object.hasOwn(values, "postServiceBufferMinutes");
  if (
    Object.keys(values).length !== (hasBuffer ? 4 : 3) ||
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
    (values.basePriceKopecks as number) > MAX_PRICE_KOPECKS ||
    (hasBuffer &&
      (!Number.isInteger(values.postServiceBufferMinutes) ||
        (values.postServiceBufferMinutes as number) < 0 ||
        (values.postServiceBufferMinutes as number) > 1440))
  ) {
    throw new CatalogInputError("invalid values");
  }
  return {
    displayName: name,
    durationMinutes: values.durationMinutes as number,
    basePriceKopecks: values.basePriceKopecks as number,
    ...(hasBuffer
      ? { postServiceBufferMinutes: values.postServiceBufferMinutes as number }
      : {}),
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
    postServiceBufferMinutes: row.post_service_buffer_minutes,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    revision: row.draft_revision,
  };
}

const SELECT_FIELDS = `id::text, display_name, duration_minutes,
  base_price_kopecks::text, post_service_buffer_minutes, active, created_at,
  draft_revision, first_published_at`;

/** Stable, bounded tenant list; never silently return a truncated catalog. */
export async function listTenantServices(
  client: PoolClient,
  tenantId: string,
): Promise<ServiceRecord[]> {
  const result = await client.query<ServiceRow>(
    `SELECT ${SELECT_FIELDS} FROM cookie_catalog.services
      WHERE tenant_id=$1::uuid ORDER BY created_at, id LIMIT $2`,
    [tenantId, MAX_TENANT_SERVICES + 1],
  );
  if (result.rows.length > MAX_TENANT_SERVICES)
    throw new Error("Service catalog exceeds F1 limit");
  return result.rows.map(mapService);
}

/**
 * Must run inside the SAME open transaction as requireTenantPermission.
 * The tenant advisory lock serializes creates, including same-key replay.
 * DB uniqueness is the final arbiter; changed payload with same key is a 409.
 * This never activates/publishes a service for bookings.
 */
export async function createTenantDraftService(
  client: PoolClient,
  tenantId: string,
  actorIdentityId: string,
  key: string,
  input: CreateDraftServiceInput,
): Promise<{ service: ServiceReceipt; replayed: boolean }> {
  if (!KEY.test(key)) throw new CatalogInputError("invalid idempotency key");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.postServiceBufferMinutes === undefined ? 1 : 2,
        input.displayName,
        input.durationMinutes,
        input.basePriceKopecks,
        ...(input.postServiceBufferMinutes === undefined
          ? []
          : [input.postServiceBufferMinutes]),
      ]),
    )
    .digest("hex");

  const scope = JSON.stringify(["catalog.service.create", tenantId]);
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
  const full = await client.query(
    `SELECT 1 FROM cookie_catalog.services
      WHERE tenant_id=$1::uuid LIMIT 1 OFFSET $2`,
    [tenantId, MAX_TENANT_SERVICES - 1],
  );
  if (full.rows.length) throw new CatalogCapacityReached();
  const serviceId = randomUUID();
  // Omitting the column preserves the legacy create contract and storage
  // default. Explicit values (including zero) are always stored verbatim.
  const hasBuffer = input.postServiceBufferMinutes !== undefined;
  const inserted = await client.query<ServiceRow>(
    `INSERT INTO cookie_catalog.services
       (tenant_id,id,display_name,duration_minutes,base_price_kopecks,active${hasBuffer ? ",post_service_buffer_minutes" : ""})
       VALUES($1::uuid,$2::uuid,$3,$4,$5::bigint,false${hasBuffer ? ",$6::integer" : ""})
       RETURNING ${SELECT_FIELDS}`,
    [
      tenantId,
      serviceId,
      input.displayName,
      input.durationMinutes,
      input.basePriceKopecks,
      ...(hasBuffer ? [input.postServiceBufferMinutes] : []),
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
): Promise<ServiceReceipt> {
  if (!KEY.test(key)) throw new CatalogInputError("invalid key");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.postServiceBufferMinutes === undefined ? 1 : 2,
        serviceId,
        input.expectedRevision,
        input.displayName,
        input.durationMinutes,
        input.basePriceKopecks,
        ...(input.postServiceBufferMinutes === undefined
          ? []
          : [input.postServiceBufferMinutes]),
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
  if (!row || row.active || row.first_published_at !== null)
    throw new CatalogDraftUnavailable();
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
            post_service_buffer_minutes=COALESCE($7::integer,post_service_buffer_minutes),
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
      input.postServiceBufferMinutes ?? null,
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
