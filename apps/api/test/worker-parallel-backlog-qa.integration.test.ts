import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Pool } from "pg";

import { idempotentProviderHandler } from "../../../packages/platform-db/src/delivery-port.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { enqueueOutbox } from "../../../packages/platform-db/src/outbox.js";
import { runTrustedPostgresOutboxWorker } from "../../../packages/platform-db/src/worker.js";

const ciUrl = "postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci";

test(
  "three bounded PostgreSQL workers drain a multi-tenant backlog without duplicate ACKs",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    if (process.env.CI === "true") {
      assert.equal(process.env.TEST_DATABASE_URL, ciUrl);
    }
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 3_000,
    });
    const workerPools = Array.from(
      { length: 3 },
      (_, index) =>
        new Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          application_name: "cookie-qa-parallel-" + index,
          max: 2,
          connectionTimeoutMillis: 3_000,
        }),
    );
    const tenants = Array.from({ length: 3 }, () => ({
      id: randomUUID(),
      owner: randomUUID(),
    }));
    const tenantIds = tenants.map(({ id }) => id);
    const topic = "test.parallel.q" + randomUUID().replaceAll("-", "");
    const otherTopic = topic + ".unrelated";
    const expected = new Map<string, string>();
    const calls = new Map<string, string[]>();
    const firstHandlers = new Set<number>();
    const controller = new AbortController();
    let releaseBarrier = (): void => undefined;
    const barrier = new Promise<void>((release) => {
      releaseBarrier = release;
    });
    const jobs: ReturnType<typeof runTrustedPostgresOutboxWorker>[] = [];
    let workerError: unknown;
    const excluded: string[] = [];

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const tenant of tenants) {
          await client.query(
            "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
            [tenant.owner],
          );
          await client.query(
            `INSERT INTO cookie_tenancy.organizations
              (id,owner_identity_id,display_name)
              VALUES($1::uuid,$2::uuid,'Synthetic parallel worker QA')`,
            [tenant.id, tenant.owner],
          );
          for (let index = 0; index < 40; index++) {
            const event = await enqueueOutbox(client, {
              tenantId: tenant.id,
              // Same producer keys in different tenants must stay distinct.
              dedupeKey: "parallel-" + index,
              topic,
              payload: { synthetic: true, index },
            });
            assert.equal(event.inserted, true);
            expected.set("outbox:" + event.id, tenant.id);
          }
        }
        const future = await client.query<{ at: Date }>(
          "SELECT clock_timestamp()+interval '1 hour' AS at",
        );
        for (const [name, selectedTopic, availableAt] of [
          ["future", topic, future.rows[0]!.at],
          ["unrelated", otherTopic, undefined],
        ] as const) {
          const event = await enqueueOutbox(client, {
            tenantId: tenants[0]!.id,
            dedupeKey: name,
            topic: selectedTopic,
            payload: { synthetic: true },
            availableAt,
          });
          excluded.push(event.id);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      for (const [index, workerPool] of workerPools.entries()) {
        const handler = idempotentProviderHandler({
          supportsIdempotencyKey: true,
          async send(event) {
            const entries = calls.get(event.idempotencyKey) ?? [];
            entries.push(event.tenantId);
            calls.set(event.idempotencyKey, entries);
            // Hold all first invocations until three independent worker
            // loops each own an event. No sleep-based concurrency guess.
            firstHandlers.add(index);
            if (firstHandlers.size === workerPools.length) releaseBarrier();
            await barrier;
          },
        });
        const job = runTrustedPostgresOutboxWorker(workerPool, handler, {
          signal: controller.signal,
          topic,
          leaseMs: 30_000,
          handlerTimeoutMs: 10_000,
          idleDelayMs: 10,
          busyDelayMs: 10,
        });
        jobs.push(job);
        void job.catch((error: unknown) => {
          workerError = error;
        });
      }

      const deadline = Date.now() + 20_000;
      let delivered = 0;
      while (Date.now() < deadline) {
        if (workerError) throw workerError;
        const result = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM cookie_jobs.outbox_events
             WHERE tenant_id=ANY($1::uuid[]) AND topic=$2
               AND status='delivered'`,
          [tenantIds, topic],
        );
        delivered = result.rows[0]!.count;
        if (delivered === expected.size) break;
        await sleep(50);
      }
      assert.equal(firstHandlers.size, 3, "All workers must overlap");
      assert.equal(delivered, 120, "All due work must be durable");
      controller.abort();
      const totals = await Promise.all(jobs);
      assert.ok(totals.every((row) => row.delivered > 0));
      assert.equal(
        totals.reduce((sum, row) => sum + row.claimed, 0),
        120,
      );
      assert.equal(
        totals.reduce((sum, row) => sum + row.delivered, 0),
        120,
      );
      assert.ok(totals.every((row) => row.failed === 0 && row.stale === 0));
      assert.equal(calls.size, expected.size);
      for (const [key, tenant] of expected) {
        assert.deepEqual(calls.get(key), [tenant]);
      }
      const rows = await pool.query<{
        id: string;
        tenant_id: string;
        status: string;
        attempts: number;
        acked: boolean;
        leased: boolean;
      }>(
        `SELECT id::text,tenant_id::text,status,attempts,
                delivered_at IS NOT NULL AS acked,
                lease_token IS NOT NULL OR lease_until IS NOT NULL AS leased
           FROM cookie_jobs.outbox_events WHERE tenant_id=ANY($1::uuid[])`,
        [tenantIds],
      );
      assert.equal(rows.rows.length, 122);
      for (const row of rows.rows) {
        if (excluded.includes(row.id)) {
          assert.deepEqual(
            [row.status, row.attempts, row.acked, row.leased],
            ["pending", 0, false, false],
          );
        } else {
          assert.equal(expected.get("outbox:" + row.id), row.tenant_id);
          assert.deepEqual(
            [row.status, row.attempts, row.acked, row.leased],
            ["delivered", 1, true, false],
          );
        }
      }
      console.log("PASS: 3 concurrent bounded workers; 120 durable ACKs");
    } finally {
      controller.abort();
      releaseBarrier();
      await Promise.allSettled(jobs);
      try {
        await pool.query(
          "DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=ANY($1::uuid[])",
          [tenantIds],
        );
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=ANY($1::uuid[])",
          [tenantIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [tenants.map(({ owner }) => owner)],
        );
      } finally {
        await Promise.all([pool.end(), ...workerPools.map((p) => p.end())]);
      }
    }
  },
);
