import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "PostgreSQL opaque retention has oldest-first and member-scoped index access paths",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-retention-index-paths",
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const existing = await pool.query<{
        indexname: string;
        indexdef: string;
      }>(
        `SELECT indexname,indexdef FROM pg_indexes
          WHERE schemaname='cookie_identity'
            AND tablename='opaque_sessions'
            AND indexname=ANY($1::text[])
          ORDER BY indexname`,
        [
          [
            "opaque_sessions_retention_oldest_idx",
            "opaque_sessions_retention_member_idx",
          ],
        ],
      );
      assert.deepEqual(
        existing.rows.map((row) => row.indexname),
        [
          "opaque_sessions_retention_member_idx",
          "opaque_sessions_retention_oldest_idx",
        ],
      );
      assert.match(
        existing.rows[0]!.indexdef,
        /\(tenant_id, identity_id, issued_at, token_sha256\)/,
      );
      assert.match(existing.rows[1]!.indexdef, /\(issued_at, token_sha256\)/);

      const client = await pool.connect();
      let active = false;
      try {
        await client.query("BEGIN");
        active = true;
        // Deterministic plan-shape assertion: disable sequential scans
        // just for this transaction. It proves a usable access path exists,
        // not that PostgreSQL always chooses it on real workload statistics.
        await client.query("SET LOCAL enable_seqscan=off");
        await client.query("SET LOCAL enable_bitmapscan=off");

        const global = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT token_sha256 FROM cookie_identity.opaque_sessions
            WHERE issued_at <= clock_timestamp() - $1::integer * INTERVAL '1 second'
              AND (expires_at <= clock_timestamp() OR revoked_at IS NOT NULL)
            ORDER BY issued_at ASC,token_sha256 ASC
            LIMIT $2::integer FOR UPDATE SKIP LOCKED`,
          [7_200, 10],
        );
        assert.match(
          global.rows.map((row) => row["QUERY PLAN"]).join("\n"),
          /Index Scan using opaque_sessions_retention_oldest_idx/,
        );

        const member = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT token_sha256 FROM cookie_identity.opaque_sessions
            WHERE tenant_id=$2::uuid AND identity_id=$3::uuid
              AND issued_at <= clock_timestamp() - $1::integer * INTERVAL '1 second'
              AND (expires_at <= clock_timestamp() OR revoked_at IS NOT NULL)
            ORDER BY issued_at ASC,token_sha256 ASC
            LIMIT $4::integer FOR UPDATE SKIP LOCKED`,
          [7_200, randomUUID(), randomUUID(), 10],
        );
        assert.match(
          member.rows.map((row) => row["QUERY PLAN"]).join("\n"),
          /Index Scan using opaque_sessions_retention_member_idx/,
        );
        await client.query("COMMIT");
        active = false;
      } finally {
        if (active) {
          await client.query("ROLLBACK").catch(() => undefined);
        }
        client.release();
      }
    } finally {
      await pool.end();
    }
  },
);
