import { Pool } from "pg";

import { runSyntheticPostgresOutboxWorker } from "../../../packages/platform-db/src/index.js";

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

// pg reports idle-client failures on the pool. Losing an existing DB
// connection must not bypass the worker's bounded polling error policy.
pool.on("error", () => {
  process.stderr.write("Synthetic outbox worker idle connection lost\n");
});

const signal = new AbortController();
for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.once(event, () => signal.abort());
}

try {
  await runSyntheticPostgresOutboxWorker(pool, {
    signal: signal.signal,
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
