import type { Pool } from "pg";

import { loadMigrationManifest } from "./migrations.js";

interface LedgerRow {
  readonly filename: string;
  readonly sha256: string;
}

/**
 * The runtime and migrator must agree on the exact migration history.
 * Read the packaged files once at boot; every probe reads the durable ledger.
 * Never create tables or apply migrations in a readiness check.
 */
export async function createMigrationReadiness(
  database: Pick<Pool, "query">,
  directory: string,
): Promise<() => Promise<void>> {
  const manifest = await loadMigrationManifest(directory);
  const expected = new Map(
    manifest.map(({ filename, sha256 }) => [filename, sha256]),
  );

  return async () => {
    const { rows } = await database.query<LedgerRow>(
      "SELECT filename, sha256 FROM public.cookie_schema_migrations",
    );
    if (rows.length !== expected.size) {
      throw new Error("Database migration history does not match this release");
    }
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.filename) || expected.get(row.filename) !== row.sha256) {
        throw new Error(
          "Database migration history does not match this release",
        );
      }
      seen.add(row.filename);
    }
  };
}
