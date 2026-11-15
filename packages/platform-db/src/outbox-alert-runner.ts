import type { Pool } from "pg";

import {
  acknowledgeOutboxAlertDelivery,
  claimOutboxAlertDeliveries,
  failOutboxAlertDelivery,
  type OutboxAlertDeliveryLease,
} from "./outbox-alert-delivery.js";

/**
 * Trusted application-owned port. No HTTP/SMS/Telegram/email adapter is
 * registered in this module, and importing it starts no worker.
 * Future adapters MUST use lease.idempotencyKey for provider-side dedupe.
 */
export type OutboxAlertDeliveryHandler = (
  lease: Readonly<OutboxAlertDeliveryLease>,
  signal: AbortSignal,
) => Promise<void>;

export interface OutboxAlertRunnerTotals {
  readonly claimed: number;
  readonly acknowledged: number;
  readonly failed: number;
  readonly stale: number;
  readonly abandoned: number;
}

export interface OutboxAlertRunnerObservation {
  readonly kind: "cycle" | "storage-error" | "stopped";
  /** Operational counts only; no event IDs, tokens or raw driver errors. */
  readonly totals: Readonly<OutboxAlertRunnerTotals>;
  readonly consecutiveStorageErrors: number;
}

export interface OutboxAlertRunnerOptions {
  readonly signal: AbortSignal;
  readonly leaseMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly idleDelayMs?: number;
  readonly busyDelayMs?: number;
  readonly errorDelayMs?: number;
  readonly retryDelayMs?: number;
  readonly maxConsecutiveStorageErrors?: number;
  /** Best-effort, trusted observation callback. Never receives payloads. */
  readonly observe?: (event: OutboxAlertRunnerObservation) => void;
}

interface Config {
  readonly leaseMs: number;
  readonly handlerTimeoutMs: number;
  readonly idleDelayMs: number;
  readonly busyDelayMs: number;
  readonly errorDelayMs: number;
  readonly retryDelayMs: number;
  readonly maxConsecutiveStorageErrors: number;
}

type HandlerOutcome = "completed" | "failed" | "timed-out";
type CycleOutcome = "idle" | "acknowledged" | "failed" | "stale" | "abandoned";

function inRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validate(
  handler: OutboxAlertDeliveryHandler,
  options: OutboxAlertRunnerOptions,
): Config {
  const leaseMs = options?.leaseMs ?? 30_000;
  const handlerTimeoutMs = options?.handlerTimeoutMs ?? 20_000;
  const idleDelayMs = options?.idleDelayMs ?? 1_000;
  const busyDelayMs = options?.busyDelayMs ?? 50;
  const errorDelayMs = options?.errorDelayMs ?? 1_000;
  const retryDelayMs = options?.retryDelayMs ?? 1_000;
  const maxConsecutiveStorageErrors = options?.maxConsecutiveStorageErrors ?? 5;
  if (
    !options?.signal ||
    typeof handler !== "function" ||
    !inRange(leaseMs, 500, 600_000) ||
    !inRange(handlerTimeoutMs, 10, 599_000) ||
    // Reserve at least 100ms for the fenced ACK/fail operation.
    handlerTimeoutMs + 100 >= leaseMs ||
    !inRange(idleDelayMs, 10, 60_000) ||
    !inRange(busyDelayMs, 10, 60_000) ||
    !inRange(errorDelayMs, 10, 60_000) ||
    !inRange(retryDelayMs, 0, 3_600_000) ||
    !inRange(maxConsecutiveStorageErrors, 1, 20)
  ) {
    throw new Error("Invalid Outbox alert runner configuration");
  }
  return {
    leaseMs,
    handlerTimeoutMs,
    idleDelayMs,
    busyDelayMs,
    errorDelayMs,
    retryDelayMs,
    maxConsecutiveStorageErrors,
  };
}

function observe(
  callback: OutboxAlertRunnerOptions["observe"],
  observation: OutboxAlertRunnerObservation,
): void {
  try {
    callback?.(observation);
  } catch {
    // Observer failures must not affect leased work.
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
 * A timeout invalidates this worker's authority to ACK the lease. The
 * handler receives an abort signal but may fail to cooperate; we NEVER
 * start another handler after its timeout. Its lease instead expires
 * naturally and can be taken over using a new fencing token.
 */
async function runBoundedHandler(
  handler: OutboxAlertDeliveryHandler,
  lease: OutboxAlertDeliveryLease,
  timeoutMs: number,
): Promise<HandlerOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = Promise.resolve()
    .then(() => handler(lease, controller.signal))
    .then(
      (): HandlerOutcome => "completed",
      (): HandlerOutcome => "failed",
    );
  const timeout = new Promise<HandlerOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timed-out");
    }, timeoutMs);
  });

  try {
    return await Promise.race([result, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCycle(
  pool: Pool,
  handler: OutboxAlertDeliveryHandler,
  signal: AbortSignal,
  config: Config,
): Promise<CycleOutcome> {
  const leases = await claimOutboxAlertDeliveries(pool, {
    batchSize: 1,
    leaseMs: config.leaseMs,
  });
  const lease = leases[0];
  if (!lease) return "idle";
  // Abort during the claim may leave a lease, but never start new work.
  // The lease is reclaimed after expiry; no empty "success" ACK is forged.
  if (signal.aborted) return "abandoned";

  const result = await runBoundedHandler(
    handler,
    lease,
    config.handlerTimeoutMs,
  );
  if (result === "timed-out") return "abandoned";
  // Graceful stop: if signal was aborted DURING the handler, the handler
  // completes and we still durably ACK/fail it before stopping new claims.
  if (result === "completed") {
    const acknowledged = await acknowledgeOutboxAlertDelivery(pool, lease);
    return acknowledged ? "acknowledged" : "stale";
  }
  const failed = await failOutboxAlertDelivery(
    pool,
    lease,
    "HANDLER_FAILED",
    config.retryDelayMs,
  );
  return failed ? "failed" : "stale";
}

/**
 * Opt-in, single-flight private runner. One claimed transition per cycle;
 * never leases a batch of items waiting behind another handler.
 *
 * On cooperative shutdown, finishes at most the current bounded handler
 * and its fenced ACK/fail, then makes no new claims.
 *
 * Handler timeout is fail-closed: stop this runner, do not ACK/fail
 * potentially still-running work and allow a future fresh lease claim.
 * DB failures are retried only a bounded number of times. No raw SQL
 * errors, handler exception messages or transition identifiers reach
 * observers. A later provider must independently dedupe external effects.
 */
export async function superviseOutboxAlertDelivery(
  pool: Pool,
  handler: OutboxAlertDeliveryHandler,
  options: OutboxAlertRunnerOptions,
): Promise<Readonly<OutboxAlertRunnerTotals>> {
  const config = validate(handler, options);
  const totals = {
    claimed: 0,
    acknowledged: 0,
    failed: 0,
    stale: 0,
    abandoned: 0,
  };
  let consecutiveStorageErrors = 0;

  while (!options.signal.aborted) {
    let result: CycleOutcome;
    try {
      result = await runCycle(pool, handler, options.signal, config);
    } catch {
      consecutiveStorageErrors++;
      observe(options.observe, {
        kind: "storage-error",
        totals: { ...totals },
        consecutiveStorageErrors,
      });
      if (consecutiveStorageErrors >= config.maxConsecutiveStorageErrors) {
        throw new Error("Outbox alert runner stopped after storage failures");
      }
      await sleepUnlessAborted(config.errorDelayMs, options.signal);
      continue;
    }

    consecutiveStorageErrors = 0;
    if (result !== "idle") totals.claimed++;
    if (result === "acknowledged") totals.acknowledged++;
    if (result === "failed") totals.failed++;
    if (result === "stale") totals.stale++;
    if (result === "abandoned") totals.abandoned++;
    observe(options.observe, {
      kind: "cycle",
      totals: { ...totals },
      consecutiveStorageErrors,
    });

    if (result === "abandoned") {
      // It may still be executing an uncooperative external handler.
      // Never start another task in this process after abandoning work.
      throw new Error("Outbox alert runner stopped after abandoned lease");
    }

    if (!options.signal.aborted) {
      await sleepUnlessAborted(
        result === "idle" ? config.idleDelayMs : config.busyDelayMs,
        options.signal,
      );
    }
  }

  observe(options.observe, {
    kind: "stopped",
    totals: { ...totals },
    consecutiveStorageErrors,
  });
  return totals;
}
