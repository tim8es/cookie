import type { Pool } from "pg";

import {
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
    } catch {
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
}

/**
 * Opt-in worker adapter. Exactly one lease per batch until a real lease
 * renewal/handler-timeout contract exists: no processing behind a long batch.
 * The handler must be idempotent and finish before the lease expires.
 */
export function runTrustedPostgresOutboxWorker(
  pool: Pool,
  handler: (event: OutboxLease) => Promise<void>,
  options: PostgresWorkerOptions,
): Promise<Readonly<OutboxBatchResult>> {
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 600_000) {
    throw new Error("Invalid outbox lease duration");
  }
  return superviseOutboxWorker(
    () =>
      runOutboxBatch(pool, handler, {
        batchSize: 1,
        leaseMs,
        topic: options.topic,
      }),
    options,
  );
}
