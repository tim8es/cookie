import type { Pool, QueryResultRow } from "pg";

import {
  evaluateOutboxHealth,
  validateOutboxHealthPolicy,
  type OutboxHealthPolicy,
  type OutboxHealthSnapshot,
} from "./outbox-health.js";
import {
  reconcileOutboxAlerts,
  type OutboxAlertState,
  type OutboxAlertTransition,
} from "./outbox-alert-monitor.js";
import type { OutboxQueueMetrics } from "./worker.js";

interface StateRow extends QueryResultRow {
  active: unknown;
  revision: string;
}

interface MetricsRow extends QueryResultRow {
  pending: number;
  due: number;
  leased: number;
  expired_leases: number;
  delivered: number;
  dead: number;
  oldest_due_seconds: number;
}

export interface DurableOutboxAlertResult {
  /** Shared revision, monotonically increasing for each changed snapshot. */
  readonly revision: string;
  /** Latest committed reason codes and severity only. */
  readonly state: OutboxAlertState;
  /** Only transitions newly inserted by this transaction. */
  readonly transitions: readonly OutboxAlertTransition[];
  readonly status: OutboxHealthSnapshot["status"];
}

const codes = new Set([
  "DUE_BACKLOG",
  "OLDEST_DUE",
  "EXPIRED_LEASES",
  "DEAD_LETTERS",
  "METRICS_UNAVAILABLE",
]);

function parseSavedState(active: unknown): OutboxAlertState {
  if (active === null || typeof active !== "object" || Array.isArray(active)) {
    throw new Error("Invalid durable Outbox alert state");
  }
  const entries = Object.entries(active);
  if (
    entries.some(
      ([code, severity]) =>
        !codes.has(code) || (severity !== "warning" && severity !== "critical"),
    )
  ) {
    throw new Error("Invalid durable Outbox alert state");
  }
  // Build a new plain object, never trust prototype-bearing DB JSON.
  return { active: Object.fromEntries(entries) };
}

function asMetrics(row: MetricsRow | undefined): OutboxQueueMetrics {
  if (!row) throw new Error("Outbox health aggregate unavailable");
  return {
    pending: row.pending,
    due: row.due,
    leased: row.leased,
    expiredLeases: row.expired_leases,
    delivered: row.delivered,
    dead: row.dead,
    oldestDueSeconds: Math.max(0, row.oldest_due_seconds),
  };
}

/**
 * A DB transaction MUST lock the singleton before sampling Outbox counts.
 * Sampling outside that lock could replay an older sample after a newer
 * replica's observation, erroneously resolving its real alerts.
 *
 * The SQL mirrors the private worker's aggregate counters; it never loads
 * individual payloads, tenant IDs or event identifiers.
 */
const METRICS_SQL = `
  SELECT
    count(*) FILTER (WHERE status = 'pending')::integer AS pending,
    count(*) FILTER (WHERE status = 'pending'
      AND available_at <= clock_timestamp())::integer AS due,
    count(*) FILTER (WHERE status = 'leased')::integer AS leased,
    count(*) FILTER (WHERE status = 'leased'
      AND lease_until <= clock_timestamp())::integer AS expired_leases,
    count(*) FILTER (WHERE status = 'delivered')::integer AS delivered,
    count(*) FILTER (WHERE status = 'dead')::integer AS dead,
    coalesce(extract(epoch FROM clock_timestamp() - min(created_at)
      FILTER (WHERE status = 'pending'
        AND available_at <= clock_timestamp())), 0)::double precision
      AS oldest_due_seconds
  FROM cookie_jobs.outbox_events
`;

/**
 * Internal, singleton Outbox health reconcile + append-only transition log.
 * All replicas share the same PostgreSQL row lock and persisted state.
 *
 * One transaction: lock shared state -> read fresh queue counters -> reconcile
 * against persisted state -> atomically update state and append transitions.
 * A crashed process before COMMIT leaves neither partial state nor journal;
 * after COMMIT, a new process observes the committed state and cannot create
 * the same unchanged transition a second time.
 *
 * This does not perform external alert delivery and does not guarantee that
 * a later provider send is exactly once. Alert routing must consume durable
 * transitions with its own leases/fencing/provider idempotency.
 */
export async function reconcileOutboxAlertsDurably(
  pool: Pool,
  policy: OutboxHealthPolicy,
): Promise<DurableOutboxAlertResult> {
  validateOutboxHealthPolicy(policy);
  const client = await pool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;
    // Prevent a stalled peer from holding queue monitoring forever.
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    await client.query("SET LOCAL statement_timeout = '7000ms'");

    const stored = await client.query<StateRow>(
      `SELECT active, revision::text
         FROM cookie_jobs.outbox_alert_state
        WHERE singleton = true FOR UPDATE`,
    );
    const row = stored.rows[0];
    if (!row) throw new Error("Outbox alert state is not initialized");
    const previous = parseSavedState(row.active);

    const sample = await client.query<MetricsRow>(METRICS_SQL);
    const health = evaluateOutboxHealth(asMetrics(sample.rows[0]), policy);
    const decision = reconcileOutboxAlerts(previous, health);

    let revision = row.revision;
    if (decision.transitions.length > 0) {
      revision = (BigInt(row.revision) + 1n).toString();
      await client.query(
        `UPDATE cookie_jobs.outbox_alert_state
           SET active=$1::jsonb, revision=$2::bigint,
               updated_at=clock_timestamp()
         WHERE singleton=true`,
        [JSON.stringify(decision.state.active), revision],
      );
      for (const change of decision.transitions) {
        await client.query(
          `INSERT INTO cookie_jobs.outbox_alert_transitions
             (revision, code, kind, previous_severity, severity)
           VALUES ($1::bigint,$2,$3,$4,$5)`,
          [
            revision,
            change.code,
            change.kind,
            change.previousSeverity ?? null,
            change.severity ?? null,
          ],
        );
      }
    }

    await client.query("COMMIT");
    active = false;
    return {
      revision,
      state: decision.state,
      transitions: decision.transitions,
      status: health.status,
    };
  } catch {
    if (active) await client.query("ROLLBACK").catch(() => undefined);
    // Do not propagate SQL text, credentials or event details to consumers.
    throw new Error("Outbox alert persistence failed");
  } finally {
    client.release();
  }
}
