import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  enqueueOutbox,
  runSyntheticPostgresOutboxWorker,
} from "../../../packages/platform-db/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "public synthetic worker capability handles only marked synthetic events",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-synthetic-worker-port-test",
      max: 3,
    });
    const tenantId = randomUUID();
    const owner = randomUUID();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1::uuid,$2::uuid,'Synthetic worker capability')`,
        [tenantId, owner],
      );
      const client = await pool.connect();
      const ids: string[] = [];
      try {
        for (const item of [
          { topic: "test.synthetic", synthetic: true },
          { topic: "test.synthetic", synthetic: false },
          { topic: "booking.confirmed", synthetic: true },
        ]) {
          const event = await enqueueOutbox(client, {
            tenantId,
            topic: item.topic,
            payload: { synthetic: item.synthetic },
            dedupeKey: randomUUID(),
            maxAttempts: 1,
          });
          ids.push(event.id);
        }
      } finally {
        client.release();
      }

      const observations: unknown[] = [];
      const totals = await runSyntheticPostgresOutboxWorker(pool, {
        signal: controller.signal,
        observe(sample) {
          observations.push(sample);
          if (sample.totals.claimed >= 2) controller.abort();
        },
      });
      assert.deepEqual(totals, {
        claimed: 2,
        delivered: 1,
        failed: 1,
        stale: 0,
      });
      assert.doesNotMatch(
        JSON.stringify(observations),
        /payload|tenantId|leaseToken/,
      );

      const persisted = await pool.query<{
        id: string;
        status: string;
        attempts: number;
        last_failure_code: string | null;
      }>(
        `SELECT id::text,status,attempts,last_failure_code
           FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
        [tenantId, ids],
      );
      const state = new Map(persisted.rows.map((row) => [row.id, row]));
      assert.deepEqual(
        ids.map((id) => {
          const row = state.get(id);
          assert.ok(row);
          return [row.status, row.attempts, row.last_failure_code];
        }),
        [
          ["delivered", 1, null],
          ["dead", 1, "DELIVERY_FAILED"],
          ["pending", 0, null],
        ],
      );
    } finally {
      clearTimeout(deadline);
      try {
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenantId],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [owner],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
