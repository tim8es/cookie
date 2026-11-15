import { createHash } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { OutboxAlertDeliveryLease } from "./outbox-alert-delivery.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSITION_ID = /^[1-9][0-9]{0,18}$/;
const MAX_BIGINT = 9223372036854775807n;

interface DeliveryRow extends QueryResultRow {
  status: string;
  attempts: number;
  manual_replay_count: number;
}

interface ReceiptRow extends QueryResultRow {
  transition_id: string;
  requeued: boolean;
  replay_count: number | null;
}

export interface TrustedAlertOperator {
  /** Verified in an independent trusted AuthN pipeline, NEVER client JSON. */
  readonly identityId: string;
  readonly correlationId: string;
}

export interface ReplayDeadAlertRequest {
  readonly operator: TrustedAlertOperator;
  readonly transitionId: string;
  /** Stable caller-provided command key. Never written raw to the database. */
  readonly idempotencyKey: string;
}

/**
 * A mandatory trusted authorization port. There is intentionally no
 * default owner/admin mapping for GLOBAL operational alerts in F1.
 * The caller must independently verify an explicitly approved global
 * operator policy inside this transaction; a tenant Owner is NOT enough.
 */
export type AssertMayReplayDeadAlert = (
  client: PoolClient,
  operator: TrustedAlertOperator,
) => Promise<void>;

export interface ReplayDeadAlertResult {
  readonly requeued: boolean;
  readonly replayCount: number | null;
}

function validTransitionId(value: string): boolean {
  return (
    typeof value === "string" &&
    TRANSITION_ID.test(value) &&
    BigInt(value) <= MAX_BIGINT
  );
}

function validateReplay(
  request: ReplayDeadAlertRequest,
  assertMayReplay: AssertMayReplayDeadAlert,
): void {
  if (
    !request?.operator ||
    typeof assertMayReplay !== "function" ||
    typeof request.operator.identityId !== "string" ||
    !UUID.test(request.operator.identityId) ||
    typeof request.operator.correlationId !== "string" ||
    request.operator.correlationId.length < 1 ||
    request.operator.correlationId.length > 128 ||
    Array.from(request.operator.correlationId).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    !validTransitionId(request.transitionId) ||
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length < 1 ||
    request.idempotencyKey.length > 128
  ) {
    throw new Error("Invalid trusted alert replay metadata");
  }
}

/**
 * Explicitly authorized, transactionally audited replay of ONE dead-letter.
 * No public API, provider call, or default authorization policy.
 *
 * Advisory key serialization + immutable receipts make retries after an
 * ambiguous COMMIT result idempotent, even when status has changed again.
 * Transition IDs and provider idempotency keys remain stable through replay.
 */
export async function replayDeadOutboxAlertDelivery(
  pool: Pool,
  request: ReplayDeadAlertRequest,
  assertMayReplay: AssertMayReplayDeadAlert,
): Promise<ReplayDeadAlertResult> {
  validateReplay(request, assertMayReplay);
  const operatorId = request.operator.identityId.toLowerCase();
  const keyHash = createHash("sha256")
    .update(
      JSON.stringify([
        "outbox.alert.delivery.replay",
        operatorId,
        request.idempotencyKey,
      ]),
    )
    .digest("hex");

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    await client.query("SET LOCAL statement_timeout = '7000ms'");

    // This is a required external policy decision, not inferred from a
    // tenant's permissions or the identity UUID provided by the caller.
    await assertMayReplay(client, request.operator);

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [JSON.stringify([operatorId, keyHash])],
    );
    const previous = await client.query<ReceiptRow>(
      `SELECT transition_id::text, requeued, replay_count
         FROM cookie_jobs.outbox_alert_replay_receipts
        WHERE operator_identity_id=$1::uuid AND key_sha256=$2`,
      [operatorId, keyHash],
    );
    const saved = previous.rows[0];
    if (saved) {
      if (saved.transition_id !== request.transitionId) {
        throw new Error("Alert replay key reused with a different transition");
      }
      await client.query("COMMIT");
      inTransaction = false;
      return { requeued: saved.requeued, replayCount: saved.replay_count };
    }

    const current = await client.query<DeliveryRow>(
      `SELECT status, attempts, manual_replay_count
         FROM cookie_jobs.outbox_alert_delivery
        WHERE transition_id=$1::bigint FOR UPDATE`,
      [request.transitionId],
    );
    const row = current.rows[0];
    if (!row) throw new Error("Alert transition unavailable");

    const requeued = row.status === "dead" && row.manual_replay_count < 3;
    const replayCount = row.manual_replay_count + (requeued ? 1 : 0);
    if (requeued) {
      await client.query(
        `UPDATE cookie_jobs.outbox_alert_delivery
            SET status='pending', attempts=0,
                lease_token=NULL, lease_until=NULL, lease_started_at=NULL,
                delivered_at=NULL, available_at=clock_timestamp(),
                last_failure_code=NULL, manual_replay_count=$2
          WHERE transition_id=$1::bigint AND status='dead'`,
        [request.transitionId, replayCount],
      );
      await client.query(
        `INSERT INTO cookie_jobs.outbox_alert_replay_audit
           (transition_id,operator_identity_id,correlation_id,
            replay_number,previous_attempts)
         VALUES ($1::bigint,$2::uuid,$3,$4,$5)`,
        [
          request.transitionId,
          operatorId,
          request.operator.correlationId,
          replayCount,
          row.attempts,
        ],
      );
    }

    await client.query(
      `INSERT INTO cookie_jobs.outbox_alert_replay_receipts
         (operator_identity_id,key_sha256,transition_id,requeued,replay_count)
       VALUES ($1::uuid,$2,$3::bigint,$4,$5)`,
      [operatorId, keyHash, request.transitionId, requeued, replayCount],
    );
    await client.query("COMMIT");
    inTransaction = false;
    return { requeued, replayCount };
  } catch {
    if (inTransaction) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw new Error("Outbox alert replay refused");
  } finally {
    client.release();
  }
}

function validateRenewal(
  lease: Pick<OutboxAlertDeliveryLease, "transitionId" | "leaseToken">,
  extendMs: number,
): void {
  if (
    !lease ||
    !validTransitionId(lease.transitionId) ||
    typeof lease.leaseToken !== "string" ||
    !UUID.test(lease.leaseToken) ||
    !Number.isSafeInteger(extendMs) ||
    extendMs < 1 ||
    extendMs > 600_000
  ) {
    throw new Error("Invalid Outbox alert lease renewal");
  }
}

/**
 * Heartbeat a LIVE lease only when extending beyond the current deadline.
 * The original token stays unchanged and stale holders cannot renew it.
 * A new attempt resets lease_started_at. Each individual attempt cannot
 * hold a lease for longer than 15 minutes even with infinite heartbeats.
 */
export async function renewOutboxAlertDeliveryLease(
  pool: Pool,
  lease: Pick<OutboxAlertDeliveryLease, "transitionId" | "leaseToken">,
  extendMs: number,
): Promise<boolean> {
  validateRenewal(lease, extendMs);
  try {
    const result = await pool.query(
      `UPDATE cookie_jobs.outbox_alert_delivery
          SET lease_until=clock_timestamp()
            + ($3::integer * interval '1 millisecond')
        WHERE transition_id=$1::bigint
          AND lease_token=$2::uuid
          AND status='leased'
          AND lease_until > clock_timestamp()
          AND lease_started_at IS NOT NULL
          AND lease_until < clock_timestamp()
            + ($3::integer * interval '1 millisecond')
          AND clock_timestamp() + ($3::integer * interval '1 millisecond')
              <= lease_started_at + interval '15 minutes'
        RETURNING transition_id`,
      [lease.transitionId, lease.leaseToken, extendMs],
    );
    return result.rowCount === 1;
  } catch {
    throw new Error("Outbox alert lease renewal failed");
  }
}
