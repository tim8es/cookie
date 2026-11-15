import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "PostgreSQL migrations are repeatable and forbid a rewritten history",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-integration-test",
      max: 2,
    });
    const directory = resolve(process.cwd(), "db/migrations");
    let tempDir: string | undefined;
    try {
      const firstRun = await runMigrations(pool, directory);
      assert.ok(
        firstRun.length === 0 || firstRun.includes("0001_bootstrap.sql"),
      );

      const secondRun = await runMigrations(pool, directory);
      assert.deepEqual(secondRun, []);

      const schema = await pool.query<{ name: string }>(
        "SELECT nspname AS name FROM pg_namespace WHERE nspname = 'cookie'",
      );
      assert.equal(schema.rows[0]?.name, "cookie");

      const tracked = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.cookie_schema_migrations",
      );
      assert.equal(tracked.rows[0]?.count, "10");

      tempDir = await mkdtemp(join(tmpdir(), "cookie-migration-"));
      const sql = await readFile(join(directory, "0001_bootstrap.sql"), "utf8");
      await writeFile(
        join(tempDir, "0001_bootstrap.sql"),
        sql + "\nSELECT 1;\n",
      );
      await assert.rejects(runMigrations(pool, tempDir), /checksum mismatch/);

      await writeFile(join(tempDir, "0001_duplicate.sql"), "SELECT 1;\n");
      await assert.rejects(
        runMigrations(pool, tempDir),
        /Duplicate migration sequence number: 0001/,
      );
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
      await pool.end();
    }
  },
);
