import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createMigrationReadiness } from "../../../packages/platform-db/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { createApp } from "../src/app.js";

test(
  "real PostgreSQL health rejects incomplete and incompatible migration history",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-schema-readiness-test",
      max: 2,
    });
    try {
      const directory = resolve(process.cwd(), "db/migrations");
      await runMigrations(pool, directory);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const app = createApp(client, {
          databaseReadiness: await createMigrationReadiness(client, directory),
        });
        try {
          const ready = () =>
            app.inject({ method: "GET", url: "/health/ready" });
          assert.equal((await ready()).statusCode, 200);

          // Simulate bad histories inside rollback-only savepoints. Do not
          // permanently alter the shared disposable integration database.
          const cases = [
            "DELETE FROM public.cookie_schema_migrations WHERE filename = '0001_bootstrap.sql'",
            "UPDATE public.cookie_schema_migrations SET sha256 = repeat('0', 64) WHERE filename = '0001_bootstrap.sql'",
            "INSERT INTO public.cookie_schema_migrations(filename, sha256) VALUES ('9999_future.sql', repeat('0', 64))",
            "ALTER TABLE public.cookie_schema_migrations RENAME TO cookie_schema_migrations_probe",
          ];
          for (const sql of cases) {
            await client.query("SAVEPOINT readiness_case");
            await client.query(sql);
            const response = await ready();
            assert.equal(response.statusCode, 503);
            assert.deepEqual(response.json(), {
              service: "cookie-api",
              status: "not-ready",
            });
            const live = await app.inject({
              method: "GET",
              url: "/health/live",
            });
            assert.equal(live.statusCode, 200);
            await client.query("ROLLBACK TO SAVEPOINT readiness_case");
            await client.query("RELEASE SAVEPOINT readiness_case");
            assert.equal((await ready()).statusCode, 200);
          }
        } finally {
          await app.close();
        }
      } finally {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    } finally {
      await pool.end();
    }
  },
);
