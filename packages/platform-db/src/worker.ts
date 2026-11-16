import type { Pool } from "pg";

import {
  acknowledgeOutbox,
  claimOutbox,
  failOutbox,
  retryDelayMs,
  runOutboxBatch,
  type OutboxClaimOptions,
  type OutboxLease,
} from "./outbox.js";

export interface OutboxQueueMetrics {
  readonly pending: number;
  readonly due: number;
  readonly leased: number;
  readonly expiredLeases: number;
  readonly delivered: number;
  readonly dead: number;
  /** Oldest due event, zero if none. Aggregate only: no payloads/tenant IDs. */
  readonly oldestDueSeconds: number;
}

interface OutboxMetricsRow {
  pending: number;
  due: number;
  leased: number;
  expired_leases: number;
  delivered: number;
  dead: number;
  oldest_due_seconds: number;
}

/** For an internal monitoring agent; do not expose an unauthenticated endpoint. */
export async function readOutboxQueueMetrics(
  pool: Pool,
): Promise<OutboxQueueMetrics> {
  const query = await pool.query<OutboxMetricsRow>(`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::integer AS pending,
      count(*) FILTER (WHERE status = 'pending' AND available_at <= clock_timestamp())::integer AS due,
      count(*) FILTER (WHERE status = 'leased')::integer AS leased,
      count(*) FILTER (WHERE status = 'leased' AND lease_until <= clock_timestamp())::integer AS expired_leases,
      count(*) FILTER (WHERE status = 'delivered')::integer AS delivered,
      count(*) FILTER (WHERE status = 'dead')::integer AS dead,
      coalesce(extract(epoch FROM clock_timestamp() - min(created_at)
        FILTER (WHERE status = 'pending' AND available_at <= clock_timestamp())), 0)::double precision
        AS oldest_due_seconds
    FROM cookie_jobs.outbox_events
  `);
  const row = query.rows[0];
  if (!row) throw new Error("Outbox aggregate metrics query failed");
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

export type OutboxBatchResult = Awaited<ReturnType<typeof runOutboxBatch>>;

export interface WorkerObservation {
  readonly kind: "batch" | "poll-error" | "stopped";
  readonly totals: Readonly<OutboxBatchResult>;
  /** Database/claim failures only; handler errors are already recorded as retries. */
  readonly consecutivePollErrors: number;
}

export interface OutboxWorkerOptions {
  readonly signal: AbortSignal;
  readonly idleDelayMs?: number;
  readonly busyDelayMs?: number;
  readonly maxConsecutivePollErrors?: number;
  /** Non-throwing reporting callback. Never receives event payloads. */
  readonly observe?: (sample: WorkerObservation) => void;
}

function validDelay(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 10 && value <= 60_000;
}

function safeObserve(
  callback: OutboxWorkerOptions["observe"],
  observation: WorkerObservation,
): void {
  try {
    callback?.(observation);
  } catch {
    // A metric sink must not acknowledge, discard or interrupt queued work.
  }
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/**
 * Supervise one batch at a time. Shutdown stops new claims and lets the
 * in-flight handler finish. No timer, logger or API is started on import.
 * Repeated database errors fail closed rather than retrying indefinitely.
 */
export async function superviseOutboxWorker(
  runOnce: () => Promise<OutboxBatchResult>,
  options: OutboxWorkerOptions,
): Promise<Readonly<OutboxBatchResult>> {
  const idleDelayMs = options.idleDelayMs ?? 1_000;
  const busyDelayMs = options.busyDelayMs ?? 50;
  const maxErrors = options.maxConsecutivePollErrors ?? 5;
  if (
    !validDelay(idleDelayMs) ||
    !validDelay(busyDelayMs) ||
    !Number.isSafeInteger(maxErrors) ||
    maxErrors < 1 ||
    maxErrors > 20
  ) {
    throw new Error("Invalid outbox supervisor configuration");
  }

  const totals = { claimed: 0, delivered: 0, failed: 0, stale: 0 };
  let consecutivePollErrors = 0;
  while (!options.signal.aborted) {
    let claimed = 0;
    try {
      const outcome = await runOnce();
      totals.claimed += outcome.claimed;
      totals.delivered += outcome.delivered;
      totals.failed += outcome.failed;
      totals.stale += outcome.stale;
      claimed = outcome.claimed;
      consecutivePollErrors = 0;
      safeObserve(options.observe, {
        kind: "batch",
        totals: { ...totals },
        consecutivePollErrors,
      });
    } catch (error) {
      if (error instanceof AbandonedOutboxLeaseError) {
        // A timed-out external handler may still be running. Do not claim
        // another event in this process or mistake timeout for a DB outage.
        throw new Error("Outbox supervisor stopped after abandoned lease");
      }
      // Never expose PostgreSQL error strings, credentials or event payloads.
      consecutivePollErrors++;
      safeObserve(options.observe, {
        kind: "poll-error",
        totals: { ...totals },
        consecutivePollErrors,
      });
      if (consecutivePollErrors >= maxErrors) {
        throw new Error(
          "Outbox supervisor halted after repeated polling errors",
        );
      }
    }

    if (!options.signal.aborted) {
      await sleepUnlessAborted(
        claimed > 0 ? busyDelayMs : idleDelayMs,
        options.signal,
      );
    }
  }
  safeObserve(options.observe, {
    kind: "stopped",
    totals: { ...totals },
    consecutivePollErrors,
  });
  return totals;
}

export interface PostgresWorkerOptions extends OutboxWorkerOptions {
  readonly leaseMs?: OutboxClaimOptions["leaseMs"];
  readonly topic?: OutboxClaimOptions["topic"];
  /**
   * Opt-in handler deadline. Must leave >100ms of lease time for ACK/fail.
   * On timeout, leave the lease untouched and stop the worker permanently.
   */
  readonly handlerTimeoutMs?: number;
}

class AbandonedOutboxLeaseError extends Error {}

type HandlerOutcome = "completed" | "failed" | "timed-out";

async function runBoundedOutboxBatch(
  pool: Pool,
  handler: (event: OutboxLease, signal: AbortSignal) => Promise<void>,
  options: PostgresWorkerOptions,
  leaseMs: number,
  timeoutMs: number,
): Promise<OutboxBatchResult> {
  const leases = await claimOutbox(pool, {
    batchSize: 1,
    leaseMs,
    topic: options.topic,
  });
  const lease = leases[0];
  if (!lease) return { claimed: 0, delivered: 0, failed: 0, stale: 0 };

  // A stop arriving during the claim must not initiate new external work.
  // The current lease can be recovered by a new worker after expiry.
  if (options.signal.aborted) throw new AbandonedOutboxLeaseError();

  const handlerController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve()
    .then(() => handler(lease, handlerController.signal))
    .then(
      (): HandlerOutcome => "completed",
      (): HandlerOutcome => "failed",
    );
  const timeout = new Promise<HandlerOutcome>((resolve) => {
    timer = setTimeout(() => {
      handlerController.abort();
      resolve("timed-out");
    }, timeoutMs);
  });

  let outcome: HandlerOutcome;
  try {
    outcome = await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (outcome === "timed-out") {
    // An uncooperative handler may still perform an external effect.
    // NEVER ack/fail its lease, nor run another handler in this process.
    throw new AbandonedOutboxLeaseError();
  }

  if (outcome === "completed") {
    const acknowledged = await acknowledgeOutbox(pool, lease);
    return {
      claimed: 1,
      delivered: acknowledged ? 1 : 0,
      failed: 0,
      stale: acknowledged ? 0 : 1,
    };
  }
  const failed = await failOutbox(
    pool,
    lease,
    "DELIVERY_FAILED",
    retryDelayMs(lease.attempts),
  );
  return {
    claimed: 1,
    delivered: 0,
    failed: failed ? 1 : 0,
    stale: failed ? 0 : 1,
  };
}

/**
 * Opt-in single-event worker adapter. With handlerTimeoutMs, a deadline
 * aborts the handler, leaves the leased event unacknowledged and terminates
 * the supervisor. Lease expiry plus fencing permits a separate worker to
 * recover safely. External providers must still dedupe by stable event ID.
 *
 * Omitting handlerTimeoutMs retains the legacy one-pass adapter behavior
 * for existing callers; new worker processes should always configure it.
 */
export function runTrustedPostgresOutboxWorker(
  pool: Pool,
  handler: (event: OutboxLease, signal: AbortSignal) => Promise<void>,
  options: PostgresWorkerOptions,
): Promise<Readonly<OutboxBatchResult>> {
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 600_000) {
    throw new Error("Invalid outbox lease duration");
  }
  const handlerTimeoutMs = options.handlerTimeoutMs;
  if (
    handlerTimeoutMs !== undefined &&
    (!Number.isSafeInteger(handlerTimeoutMs) ||
      handlerTimeoutMs < 10 ||
      handlerTimeoutMs > 599_000 ||
      handlerTimeoutMs + 100 >= leaseMs)
  ) {
    throw new Error("Invalid outbox handler timeout");
  }
  return superviseOutboxWorker(
    () =>
      handlerTimeoutMs === undefined
        ? runOutboxBatch(pool, (event) => handler(event, options.signal), {
            batchSize: 1,
            leaseMs,
            topic: options.topic,
          })
        : runBoundedOutboxBatch(
            pool,
            handler,
            options,
            leaseMs,
            handlerTimeoutMs,
          ),
    options,
  );
}
