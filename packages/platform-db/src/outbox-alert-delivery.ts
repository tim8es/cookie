import type { Pool, QueryResultRow } from "pg";

import type { OutboxAlertChangeKind } from "./outbox-alert-monitor.js";
import type {
  OutboxHealthCode,
  OutboxHealthSeverity,
} from "./outbox-health.js";

export interface OutboxAlertDeliveryLease {
  readonly transitionId: string;
  readonly revision: string;
  readonly code: OutboxHealthCode;
  readonly kind: OutboxAlertChangeKind;
  readonly previousSeverity: OutboxHealthSeverity | null;
  readonly severity: OutboxHealthSeverity | null;
  readonly attempts: number;
  /** Fencing token; may change on any retry or expired lease takeover. */
  readonly leaseToken: string;
  /** Stable over attempts. No external provider is connected. */
  readonly idempotencyKey: string;
}

export interface AlertDeliveryClaimOptions {
  readonly batchSize?: number;
  readonly leaseMs?: number;
}

interface ClaimRow extends QueryResultRow {
  transition_id: string;
  revision: string;
  code: OutboxHealthCode;
  kind: OutboxAlertChangeKind;
  previous_severity: OutboxHealthSeverity | null;
  severity: OutboxHealthSeverity | null;
  attempts: number;
  lease_token: string;
}

function validInt(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failurePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

function validTransitionId(id: string): boolean {
  if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id)) {
    return false;
  }
  return BigInt(id) <= 9223372036854775807n;
}

function validateLeaseKey(
  lease: Pick<OutboxAlertDeliveryLease, "transitionId" | "leaseToken">,
): void {
  if (
    !lease ||
    !validTransitionId(lease.transitionId) ||
    typeof lease.leaseToken !== "string" ||
    !uuidPattern.test(lease.leaseToken)
  ) {
    throw new Error("Invalid Outbox alert delivery lease");
  }
}

/**
 * Trusted internal worker only. Claims are protected by PostgreSQL row
 * locks and fresh random lease fencing tokens (never an in-memory mutex).
 * Multiple processes sharing the DB cannot claim the same active lease.
 *
 * A crash after external acceptance but before ack MAY cause redelivery:
 * the future provider adapter must implement the stable idempotency key.
 * This module sends no network traffic and contains no provider credentials.
 */
export async function claimOutboxAlertDeliveries(
  pool: Pool,
  options: AlertDeliveryClaimOptions = {},
): Promise<readonly OutboxAlertDeliveryLease[]> {
  const batchSize = options.batchSize ?? 10;
  const leaseMs = options.leaseMs ?? 30_000;
  if (!validInt(batchSize, 1, 100) || !validInt(leaseMs, 1, 600_000)) {
    throw new Error("Invalid Outbox alert claim limits");
  }

  // Best-effort cleanup must not wait for an unrelated expired row
  // currently locked by another transaction. A later claim will sweep it.
  await pool.query(
    `WITH expired AS (
       SELECT transition_id
         FROM cookie_jobs.outbox_alert_delivery
        WHERE status='leased' AND lease_until <= clock_timestamp()
          AND attempts >= max_attempts
        ORDER BY lease_until, transition_id
        FOR UPDATE SKIP LOCKED
     )
     UPDATE cookie_jobs.outbox_alert_delivery AS delivery
        SET status='dead', lease_token=NULL, lease_until=NULL,
            last_failure_code='LEASE_EXHAUSTED'
       FROM expired
      WHERE delivery.transition_id=expired.transition_id`,
  );

  const selected = await pool.query<ClaimRow>(
    `WITH chosen AS (
       SELECT transition_id
         FROM cookie_jobs.outbox_alert_delivery
        WHERE attempts < max_attempts
          AND (
            (status='pending' AND available_at <= clock_timestamp())
            OR (status='leased' AND lease_until <= clock_timestamp())
          )
        ORDER BY
          CASE WHEN status='leased' THEN lease_until ELSE available_at END,
          transition_id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     ), leased AS (
       UPDATE cookie_jobs.outbox_alert_delivery AS delivery
          SET status='leased',
              attempts=delivery.attempts + 1,
              lease_token=gen_random_uuid(),
              lease_started_at=clock_timestamp(),
              lease_until=clock_timestamp() + ($2::integer * interval '1 millisecond')
         FROM chosen
        WHERE delivery.transition_id=chosen.transition_id
        RETURNING delivery.transition_id, delivery.attempts, delivery.lease_token
     )
     SELECT leased.transition_id::text,
            transition.revision::text,
            transition.code, transition.kind,
            transition.previous_severity, transition.severity,
            leased.attempts, leased.lease_token::text
       FROM leased
       JOIN cookie_jobs.outbox_alert_transitions AS transition
         ON transition.id=leased.transition_id
      ORDER BY leased.transition_id`,
    [batchSize, leaseMs],
  );

  return selected.rows.map((row) => ({
    transitionId: row.transition_id,
    revision: row.revision,
    code: row.code,
    kind: row.kind,
    previousSeverity: row.previous_severity,
    severity: row.severity,
    attempts: row.attempts,
    leaseToken: row.lease_token,
    idempotencyKey: "outbox-alert-transition:" + row.transition_id,
  }));
}

/** Returns false for stale, expired, already acknowledged or absent leases. */
export async function acknowledgeOutboxAlertDelivery(
  pool: Pool,
  lease: Pick<OutboxAlertDeliveryLease, "transitionId" | "leaseToken">,
): Promise<boolean> {
  validateLeaseKey(lease);
  const result = await pool.query<{ transition_id: string }>(
    `UPDATE cookie_jobs.outbox_alert_delivery
       SET status='delivered', delivered_at=clock_timestamp(),
           lease_token=NULL, lease_until=NULL, last_failure_code=NULL
     WHERE transition_id=$1::bigint AND lease_token=$2::uuid
       AND status='leased' AND lease_until > clock_timestamp()
     RETURNING transition_id::text`,
    [lease.transitionId, lease.leaseToken],
  );
  return result.rowCount === 1;
}

/**
 * Fail one held lease. The next attempt has an explicit bounded delay.
 * The last failure goes permanently to dead-letter; there is no automatic
 * replay beyond the configured max_attempts. Failure codes are not free text.
 */
export async function failOutboxAlertDelivery(
  pool: Pool,
  lease: Pick<OutboxAlertDeliveryLease, "transitionId" | "leaseToken">,
  failureCode: string,
  delayMs: number,
): Promise<boolean> {
  validateLeaseKey(lease);
  if (
    typeof failureCode !== "string" ||
    !failurePattern.test(failureCode) ||
    !validInt(delayMs, 0, 3_600_000)
  ) {
    throw new Error("Invalid Outbox alert delivery failure metadata");
  }
  const result = await pool.query<{ transition_id: string }>(
    `UPDATE cookie_jobs.outbox_alert_delivery
       SET status=CASE WHEN attempts>=max_attempts
            THEN 'dead' ELSE 'pending' END,
           available_at=clock_timestamp() + ($4::integer * interval '1 millisecond'),
           lease_token=NULL, lease_until=NULL,
           last_failure_code=$3
     WHERE transition_id=$1::bigint AND lease_token=$2::uuid
       AND status='leased' AND lease_until > clock_timestamp()
     RETURNING transition_id::text`,
    [lease.transitionId, lease.leaseToken, failureCode, delayMs],
  );
  return result.rowCount === 1;
}
