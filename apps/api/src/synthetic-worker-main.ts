import { Pool } from "pg";

import { idempotentProviderHandler } from "../../../packages/platform-db/src/delivery-port.js";
import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

import { parseSyntheticWorkerConfig } from "./synthetic-worker-config.js";

/**
 * Explicit developer-only process. No real network channel or customer event
 * is supported: the filter claims only "test.synthetic" outbox events.
 */
const config = parseSyntheticWorkerConfig(process.env);
const pool = new Pool({
  connectionString: config.databaseUrl,
  application_name: "cookie-synthetic-worker",
  max: 2,
  connectionTimeoutMillis: 3_000,
});

const signal = new AbortController();
for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.once(event, () => signal.abort());
}

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

try {
  await runTrustedPostgresOutboxWorker(pool, syntheticHandler, {
    signal: signal.signal,
    topic: "test.synthetic",
    leaseMs: 30_000,
    idleDelayMs: 1000,
    busyDelayMs: 50,
    observe(snapshot) {
      // Counters only. No tokens, tenant IDs, messages or payload.
      if (snapshot.kind !== "batch" || snapshot.totals.claimed > 0) {
        process.stdout.write(
          JSON.stringify({
            state: snapshot.kind,
            totals: snapshot.totals,
            consecutivePollErrors: snapshot.consecutivePollErrors,
          }) + "\n",
        );
      }
    },
  });
} catch {
  process.stderr.write(
    "Synthetic outbox worker stopped after an internal failure\n",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
