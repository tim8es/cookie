import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "failed PostgreSQL migration rolls back DDL and history, then releases its lock",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-migration-failure-test",
      max: 1,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 5_000,
    });
    const directory = resolve(process.cwd(), "db/migrations");
    const temporary = await mkdtemp(join(tmpdir(), "cookie-migration-failure-"));
    const filename = "9999_failure_probe.sql";
    const table = "cookie_migration_probe_" + randomUUID().replaceAll("-", "");
    try {
      await runMigrations(pool, directory);
      const files = (await readdir(directory)).filter((name) =>
        name.endsWith(".sql"),
      );
      assert.ok(!files.some((name) => name.startsWith("9999_")));
      await Promise.all(
        files.map(async (name) => {
          const sql = await readFile(join(directory, name), "utf8");
          await writeFile(join(temporary, name), sql);
        }),
      );
      await writeFile(
        join(temporary, filename),
        `CREATE TABLE public.${table} (id integer); SELECT 1 / 0;`,
      );
      await assert.rejects(runMigrations(pool, temporary), /division by zero/);

      const state = await pool.query<{ present: boolean; tracked: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present,
                EXISTS (SELECT 1 FROM public.cookie_schema_migrations
                         WHERE filename=$2) AS tracked`,
        [`public.${table}`, filename],
      );
      assert.deepEqual(state.rows[0], { present: false, tracked: false });
      // max=1 makes this a new usable session after failure. The runner must
      // reacquire the advisory lock and observe the unchanged durable history.
      assert.deepEqual(await runMigrations(pool, directory), []);
    } finally {
      try {
        await rm(temporary, { recursive: true, force: true });
      } finally {
        await pool.end();
      }
    }
  },
);
