import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Pool } from "pg";

const LOCK_KEY = "7618342059";

interface AppliedMigration {
  readonly filename: string;
  readonly sha256: string;
}

interface Migration {
  readonly filename: string;
  readonly sql: string;
  readonly sha256: string;
}

/** Load the exact sorted, checksummed SQL manifest used by the migrator. */
export async function loadMigrationManifest(
  directory: string,
): Promise<Migration[]> {
  const sqlFiles = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (sqlFiles.length === 0) {
    throw new Error("No SQL migration files found");
  }
  if (sqlFiles.some((name) => !/^\d{4}_[a-z0-9_-]+\.sql$/.test(name))) {
    throw new Error("Migration file names must match NNNN_name.sql");
  }

  const ordinals = new Set<string>();
  for (const filename of sqlFiles) {
    const ordinal = filename.slice(0, 4);
    if (ordinals.has(ordinal)) {
      throw new Error("Duplicate migration sequence number: " + ordinal);
    }
    ordinals.add(ordinal);
  }

  return Promise.all(
    sqlFiles.map(async (filename) => {
      const sql = await readFile(join(directory, filename), "utf8");
      return {
        filename,
        sql,
        sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
      };
    }),
  );
}

/**
 * Only trusted version-controlled SQL is executed. Each migration and its
 * checksum record commit atomically; a session advisory lock serializes
 * concurrent deploys using the same PostgreSQL database.
 */
export async function runMigrations(
  pool: Pool,
  directory: string,
): Promise<string[]> {
  const migrations = await loadMigrationManifest(directory);

  const client = await pool.connect();
  // A session-level advisory lock may survive an uncertain driver response.
  // Reuse this connection only after all work and unlock are acknowledged.
  let safeToReuse = false;
  const executed: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.cookie_schema_migrations (
        filename text PRIMARY KEY,
        sha256 char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const result = await client.query<AppliedMigration>(
      "SELECT filename, sha256 FROM public.cookie_schema_migrations",
    );
    const known = new Map(result.rows.map((row) => [row.filename, row.sha256]));
    const expected = new Map(
      migrations.map((migration) => [migration.filename, migration]),
    );

    // Fail before performing any new migration if history was rewritten or removed.
    for (const [filename, sha256] of known) {
      const entry = expected.get(filename);
      if (!entry) {
        throw new Error(
          `Applied migration missing from repository: ${filename}`,
        );
      }
      if (entry.sha256 !== sha256) {
        throw new Error(`Applied migration checksum mismatch: ${filename}`);
      }
    }

    for (const migration of migrations) {
      if (known.has(migration.filename)) continue;

      const begun = await client.query("BEGIN");
      if (begun.command !== "BEGIN") {
        throw new Error("Migration transaction did not begin");
      }
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO public.cookie_schema_migrations (filename, sha256) VALUES ($1, $2)",
          [migration.filename, migration.sha256],
        );
      } catch (error) {
        try {
          const rolledBack = await client.query("ROLLBACK");
          if (rolledBack.command !== "ROLLBACK") {
            throw new Error("Migration transaction did not roll back");
          }
        } catch {
          throw new Error("Migration transaction cleanup failed");
        }
        throw error;
      }

      // Do not attempt ROLLBACK or unlock after an uncertain COMMIT.
      // An explicit rerun will check the durable migration history again.
      const committed = await client.query("COMMIT");
      if (committed.command !== "COMMIT") {
        throw new Error("Migration transaction did not commit");
      }
      executed.push(migration.filename);
    }

    const unlocked = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
      [LOCK_KEY],
    );
    if (unlocked.rows[0]?.unlocked !== true) {
      throw new Error("Migration advisory lock was not released");
    }
    safeToReuse = true;
    return executed;
  } finally {
    // Destroying a failed session also releases its session-level lock and
    // rolls back any open transaction. Never return it to the idle pool.
    client.release(!safeToReuse);
  }
}
