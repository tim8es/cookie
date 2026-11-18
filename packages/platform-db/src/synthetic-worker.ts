import type { Pool } from "pg";

import { idempotentProviderHandler } from "./delivery-port.js";
import {
  runTrustedPostgresOutboxWorker,
  type OutboxBatchResult,
  type OutboxWorkerOptions,
} from "./worker.js";

/**
 * Trusted process-only capability for the explicit local/CI synthetic worker.
 * The launcher still owns config validation, connection and signal lifecycle.
 * No caller-supplied topic, handler, provider, or credentials are accepted.
 */
export function runSyntheticPostgresOutboxWorker(
  pool: Pool,
  options: Pick<OutboxWorkerOptions, "signal" | "observe">,
): Promise<Readonly<OutboxBatchResult>> {
  const syntheticHandler = idempotentProviderHandler({
    supportsIdempotencyKey: true,
    async send(event) {
      if (event.topic !== "test.synthetic" || event.payload.synthetic !== true) {
        throw new Error("Synthetic worker refuses non-synthetic event");
      }
      // No external side effect. Future real adapters require separate approval.
      void event.idempotencyKey;
    },
  });

  return runTrustedPostgresOutboxWorker(pool, syntheticHandler, {
    signal: options.signal,
    observe: options.observe,
    topic: "test.synthetic",
    leaseMs: 30_000,
    handlerTimeoutMs: 20_000,
    idleDelayMs: 1000,
    busyDelayMs: 50,
  });
}
