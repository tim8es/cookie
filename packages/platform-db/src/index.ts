/**
 * Public F1 Outbox persistence capability.
 * The caller passes a trusted PoolClient from its existing transaction;
 * this entrypoint must not run a second transaction or external provider.
 */
export { enqueueOutbox } from "./outbox.js";

export { runSqlTransaction } from "./transaction.js";

export { createMigrationReadiness } from "./schema-readiness.js";

/** Trusted standalone synthetic process; never an HTTP or provider capability. */
export { runSyntheticPostgresOutboxWorker } from "./synthetic-worker.js";
