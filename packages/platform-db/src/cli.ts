import { resolve } from "node:path";

import { Pool } from "pg";

import { runMigrations } from "./migrations.js";

/** No implicit migration on HTTP API startup: explicit controlled command only. */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "cookie-migration",
  max: 1,
  connectionTimeoutMillis: 3_000,
});
try {
  const applied = await runMigrations(
    pool,
    resolve(process.cwd(), "db/migrations"),
  );
  process.stdout.write(`Migrations applied: ${applied.length}\n`);
} finally {
  await pool.end();
}
