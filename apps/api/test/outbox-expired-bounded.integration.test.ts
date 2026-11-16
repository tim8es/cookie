import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  acknowledgeOutbox,
  claimOutbox,
  enqueueOutbox,
} from "../../../packages/platform-db/src/outbox.js";

test(
  "expired final-attempt sweep stays bounded while an unrelated ready tenant event is claimed",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-outbox-bounded-expiry",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const owner = randomUUID();
    const stalledTenant = randomUUID();
    const readyTenant = randomUUID();
    const topic = "qa.boundedexpiry";
    const ignoredTopic = "qa.othertopic";
    const budget = 25;
    const exhaustedCount = 70;
    const unrelatedCount = 4;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
         VALUES ($1::uuid, $3::uuid, 'Synthetic expired backlog'),
                ($2::uuid, $3::uuid, 'Synthetic ready delivery')`,
        [stalledTenant, readyTenant, owner],
      );

      // Generate synthetic events directly in the valid final leased state to
      // simulate a large crash backlog without performing 70 claim cycles.
      // All rows satisfy the existing database constraints.
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
           (id, tenant_id, dedupe_key, topic, payload, fingerprint,
            status, attempts, max_attempts, available_at, lease_token,
            lease_until)
         SELECT gen_random_uuid(), $1::uuid, 'sweep-' || seq.n::text,
                $2::text, '{}'::jsonb, repeat('a',64)::char(64),
                'leased', 1, 1, clock_timestamp() - interval '1 second',
                gen_random_uuid(), clock_timestamp() - interval '1 second'
           FROM generate_series(1, $3::integer) AS seq(n)`,
        [stalledTenant, topic, exhaustedCount],
      );
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
           (id, tenant_id, dedupe_key, topic, payload, fingerprint,
            status, attempts, max_attempts, available_at, lease_token,
            lease_until)
         SELECT gen_random_uuid(), $1::uuid, 'other-' || seq.n::text,
                $2::text, '{}'::jsonb, repeat('b',64)::char(64),
                'leased', 1, 1, clock_timestamp() - interval '1 second',
                gen_random_uuid(), clock_timestamp() - interval '1 second'
           FROM generate_series(1, $3::integer) AS seq(n)`,
        [stalledTenant, ignoredTopic, unrelatedCount],
      );

      const writer = await pool.connect();
      let readyId = "";
      try {
        readyId = (
          await enqueueOutbox(writer, {
            tenantId: readyTenant,
            dedupeKey: "ready-during-expiry",
            topic,
            payload: { synthetic: true },
            maxAttempts: 2,
          })
        ).id;
      } finally {
        writer.release();
      }

      const snapshot = async () => {
        const result = await pool.query<{
          topic: string;
          status: string;
          count: string;
        }>(
          `SELECT topic, status, count(*)::text AS count
             FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid
            GROUP BY topic, status ORDER BY topic, status`,
          [stalledTenant],
        );
        return result.rows;
      };

      const started = performance.now();
      const claimed = await claimOutbox(pool, {
        topic,
        batchSize: 1,
        leaseMs: 30_000,
      });
      const durationMs = Math.round(performance.now() - started);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.id, readyId);
      assert.equal(claimed[0]?.tenantId, readyTenant);
      assert.equal(claimed[0]?.attempts, 1);
      assert.equal(await acknowledgeOutbox(pool, claimed[0]!), true);
      assert.deepEqual(await snapshot(), [
        { topic, status: "dead", count: String(budget) },
        { topic, status: "leased", count: String(exhaustedCount - budget) },
        { topic: ignoredTopic, status: "leased", count: String(unrelatedCount) },
      ].sort((a, b) => a.topic.localeCompare(b.topic) || a.status.localeCompare(b.status)));

      // Report actual observed synthetic work/latency; no assumed SLA.
      console.info(
        "synthetic Outbox bounded expiry: " +
          JSON.stringify({
            reaped: budget,
            remaining: exhaustedCount - budget,
            readyDelivered: 1,
            durationMs,
          }),
      );

      await claimOutbox(pool, { topic, batchSize: 1 });
      assert.deepEqual(await snapshot(), [
        { topic, status: "dead", count: String(budget * 2) },
        { topic, status: "leased", count: String(exhaustedCount - budget * 2) },
        { topic: ignoredTopic, status: "leased", count: String(unrelatedCount) },
      ].sort((a, b) => a.topic.localeCompare(b.topic) || a.status.localeCompare(b.status)));

      await claimOutbox(pool, { topic, batchSize: 1 });
      assert.deepEqual(await snapshot(), [
        { topic, status: "dead", count: String(exhaustedCount) },
        { topic: ignoredTopic, status: "leased", count: String(unrelatedCount) },
      ].sort((a, b) => a.topic.localeCompare(b.topic) || a.status.localeCompare(b.status)));

      // A topic-filtered claim never sweeps unrelated expired leases.
      await claimOutbox(pool, { topic, batchSize: 1 });
      const ignored = await pool.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid AND topic=$2 GROUP BY status`,
        [stalledTenant, ignoredTopic],
      );
      assert.deepEqual(ignored.rows, [
        { status: "leased", count: String(unrelatedCount) },
      ]);

      // Unfiltered maintenance eventually reaps the other topic too.
      assert.deepEqual(await claimOutbox(pool, { batchSize: 1 }), []);
      const final = await pool.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid GROUP BY status`,
        [stalledTenant],
      );
      assert.deepEqual(final.rows, [
        { status: "dead", count: String(exhaustedCount + unrelatedCount) },
      ]);
    } finally {
      try {
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id = ANY($1::uuid[])",
          [[stalledTenant, readyTenant]],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id = ANY($1::uuid[])",
          [[stalledTenant, readyTenant]],
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
