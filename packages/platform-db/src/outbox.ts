import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface NewOutboxEvent {
  readonly tenantId: string;
  /** Stable key for this producer action, scoped to one organization. */
  readonly dedupeKey: string;
  readonly topic: string;
  readonly payload: { readonly [key: string]: JsonValue };
  readonly maxAttempts?: number;
  readonly availableAt?: Date;
}

export interface OutboxLease {
  readonly id: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly payload: { readonly [key: string]: JsonValue };
  readonly attempts: number;
  readonly leaseToken: string;
}

export interface OutboxClaimOptions {
  readonly batchSize?: number;
  readonly leaseMs?: number;
}

interface InsertedRow extends QueryResultRow {
  id: string;
}

interface ExistingRow extends QueryResultRow {
  id: string;
  fingerprint: string;
}

interface LeaseRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  topic: string;
  payload: { readonly [key: string]: JsonValue };
  attempts: number;
  lease_token: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPIC_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const FAILURE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function integerInRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** Canonicalize nested JSON so reordered object keys remain idempotent. */
function canonical(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): JsonValue {
  if (depth > 32) throw new Error("Outbox payload nesting limit exceeded");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("Outbox payload must be JSON");
  if (seen.has(value)) throw new Error("Cyclic outbox payload");
  seen.add(value);
  let result: JsonValue;
  if (Array.isArray(value)) {
    result = value.map((element) => canonical(element, seen, depth + 1));
  } else {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error("Outbox payload must contain only plain JSON objects");
    }
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical(
        (value as Record<string, unknown>)[key],
        seen,
        depth + 1,
      );
    }
    result = sorted;
  }
  seen.delete(value);
  return result;
}

/**
 * Must receive a client already enrolled in the business command's database
 * transaction: commit/rollback of the authoritative write also covers enqueue.
 * Do not send external messages from this function.
 */
export async function enqueueOutbox(
  client: PoolClient,
  input: NewOutboxEvent,
): Promise<{ readonly id: string; readonly inserted: boolean }> {
  const maxAttempts = input.maxAttempts ?? 5;
  if (
    !UUID_PATTERN.test(input.tenantId) ||
    input.dedupeKey.length < 1 ||
    input.dedupeKey.length > 200 ||
    !TOPIC_PATTERN.test(input.topic) ||
    input.topic.length > 128 ||
    !integerInRange(maxAttempts, 1, 25) ||
    (input.availableAt !== undefined &&
      !Number.isFinite(input.availableAt.getTime()))
  ) {
    throw new Error("Invalid outbox event metadata");
  }
  if (
    !input.payload ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    throw new Error("Outbox payload must be an object");
  }
  const serialized = JSON.stringify(canonical(input.payload));
  if (Buffer.byteLength(serialized, "utf8") > 16_384) {
    throw new Error("Outbox payload exceeds F1 size limit");
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([input.topic, maxAttempts, serialized]))
    .digest("hex");
  const id = randomUUID();
  const inserted = await client.query<InsertedRow>(
    `INSERT INTO cookie_jobs.outbox_events
       (id, tenant_id, dedupe_key, topic, payload, fingerprint, max_attempts, available_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, COALESCE($8::timestamptz, clock_timestamp()))
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING id::text AS id`,
    [
      id,
      input.tenantId,
      input.dedupeKey,
      input.topic,
      serialized,
      fingerprint,
      maxAttempts,
      input.availableAt ?? null,
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, inserted: true };
  const existing = await client.query<ExistingRow>(
    `SELECT id::text AS id, fingerprint
       FROM cookie_jobs.outbox_events WHERE tenant_id = $1::uuid AND dedupe_key = $2`,
    [input.tenantId, input.dedupeKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Outbox idempotency result not found");
  if (row.fingerprint !== fingerprint) {
    throw new Error(
      "Outbox idempotency key reused with different event content",
    );
  }
  return { id: row.id, inserted: false };
}

/**
 * Trusted background worker only: all-tenant access is forbidden from web/API.
 * Atomic SKIP LOCKED selection prevents concurrent workers claiming a row
 * while its lease is active. Expired final attempts transition to dead letter.
 */
export async function claimOutbox(
  pool: Pool,
  options: OutboxClaimOptions = {},
): Promise<readonly OutboxLease[]> {
  const batchSize = options.batchSize ?? 10;
  const leaseMs = options.leaseMs ?? 30_000;
  if (
    !integerInRange(batchSize, 1, 100) ||
    !integerInRange(leaseMs, 1, 600_000)
  ) {
    throw new Error("Invalid outbox claim limits");
  }
  await pool.query(
    `UPDATE cookie_jobs.outbox_events
       SET status = 'dead', lease_token = NULL, lease_until = NULL,
           last_failure_code = 'LEASE_EXHAUSTED'
     WHERE status = 'leased' AND lease_until <= clock_timestamp()
       AND attempts >= max_attempts`,
  );

  const rows = await pool.query<LeaseRow>(
    `WITH chosen AS (
        SELECT id FROM cookie_jobs.outbox_events
        WHERE attempts < max_attempts
          AND ((status = 'pending' AND available_at <= clock_timestamp())
            OR (status = 'leased' AND lease_until <= clock_timestamp()))
        ORDER BY CASE WHEN status = 'leased' THEN lease_until ELSE available_at END,
                 created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE cookie_jobs.outbox_events AS event
      SET status = 'leased', attempts = event.attempts + 1,
          lease_token = gen_random_uuid(),
          lease_until = clock_timestamp() + ($2::integer * interval '1 millisecond')
      FROM chosen
      WHERE event.id = chosen.id
      RETURNING event.id::text AS id, event.tenant_id::text AS tenant_id,
                event.topic, event.payload, event.attempts,
                event.lease_token::text AS lease_token`,
    [batchSize, leaseMs],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    topic: row.topic,
    payload: row.payload,
    attempts: row.attempts,
    leaseToken: row.lease_token,
  }));
}

/** Lease token acts as a fencing token: a stale worker cannot ack a newer lease. */
export async function acknowledgeOutbox(
  pool: Pool,
  event: Pick<OutboxLease, "id" | "leaseToken">,
): Promise<boolean> {
  const result = await pool.query<InsertedRow>(
    `UPDATE cookie_jobs.outbox_events
       SET status = 'delivered', delivered_at = clock_timestamp(),
           lease_token = NULL, lease_until = NULL, last_failure_code = NULL
     WHERE id = $1::uuid AND lease_token = $2::uuid AND status = 'leased'
       AND lease_until > clock_timestamp()
     RETURNING id::text AS id`,
    [event.id, event.leaseToken],
  );
  return result.rows.length === 1;
}

export async function failOutbox(
  pool: Pool,
  event: Pick<OutboxLease, "id" | "leaseToken">,
  failureCode: string,
  delayMs: number,
): Promise<boolean> {
  if (
    !FAILURE_PATTERN.test(failureCode) ||
    !integerInRange(delayMs, 0, 3_600_000)
  ) {
    throw new Error("Invalid sanitized outbox failure metadata");
  }
  const result = await pool.query<InsertedRow>(
    `UPDATE cookie_jobs.outbox_events
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           available_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
           lease_token = NULL, lease_until = NULL, last_failure_code = $3
     WHERE id = $1::uuid AND lease_token = $2::uuid AND status = 'leased'
       AND lease_until > clock_timestamp()
     RETURNING id::text AS id`,
    [event.id, event.leaseToken, failureCode, delayMs],
  );
  return result.rows.length === 1;
}

export function retryDelayMs(attempt: number, random = Math.random): number {
  if (!integerInRange(attempt, 1, 25))
    throw new Error("Invalid delivery attempt");
  const jitter = random();
  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
    throw new Error("Invalid jitter");
  }
  const base = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  return Math.floor(base * (0.75 + jitter / 2));
}

/**
 * Opt-in runner. Never started from API bootstrap, no live transport included.
 * Handler MUST be idempotent: after an external success but before ack, a
 * process crash can cause another delivery. Domain Booking is unaffected.
 */
export async function runOutboxBatch(
  pool: Pool,
  handler: (event: OutboxLease) => Promise<void>,
  options: OutboxClaimOptions = {},
): Promise<{
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly stale: number;
}> {
  const jobs = await claimOutbox(pool, options);
  let delivered = 0;
  let failed = 0;
  let stale = 0;
  for (const event of jobs) {
    try {
      await handler(event);
      if (await acknowledgeOutbox(pool, event)) delivered++;
      else stale++;
    } catch {
      // Exception detail might include secrets/PII, never persist it.
      if (
        await failOutbox(
          pool,
          event,
          "DELIVERY_FAILED",
          retryDelayMs(event.attempts),
        )
      ) {
        failed++;
      } else {
        stale++;
      }
    }
  }
  return { claimed: jobs.length, delivered, failed, stale };
}
