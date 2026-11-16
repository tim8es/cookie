import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { enqueueOutbox } from "../../../packages/platform-db/src/outbox.js";

const CI_DATABASE_URL =
  "postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci";

if (
  process.env.CI !== "true" ||
  process.env.TEST_DATABASE_URL !== CI_DATABASE_URL
) {
  throw new Error("Compiled worker DB smoke requires the isolated CI database");
}

interface ExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface RunningWorker {
  readonly child: ChildProcess;
  readonly done: Promise<ExitStatus>;
  readonly stderr: () => string;
}

function startCompiledWorker(sslMode: "require" | "disable"): RunningWorker {
  const entrypoint = resolve(
    process.cwd(),
    "dist/apps/api/src/synthetic-worker-main.js",
  );
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      CI: "true",
      COOKIE_SYNTHETIC_WORKER: "enabled",
      TEST_DATABASE_URL: CI_DATABASE_URL,
      DATABASE_URL: CI_DATABASE_URL,
      PGSSLMODE: sslMode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-2_048);
  });
  const done = new Promise<ExitStatus>((finish) => {
    child.once("close", (code, signal) => finish({ code, signal }));
    child.once("error", () => finish({ code: -1, signal: null }));
  });
  return { child, done, stderr: () => output };
}

async function within<T>(
  result: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(label + " exceeded CI deadline")),
      milliseconds,
    );
  });
  try {
    return await Promise.race([result, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface EventRow {
  readonly status: string;
  readonly attempts: number;
  readonly acked: boolean;
  readonly leased: boolean;
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: CI_DATABASE_URL,
    application_name: "cookie-ci-compiled-worker-db-ack",
    max: 3,
    connectionTimeoutMillis: 5_000,
  });
  const identityId = randomUUID();
  const tenantId = randomUUID();
  let negative: RunningWorker | undefined;
  let positive: RunningWorker | undefined;

  async function snapshot(id: string): Promise<EventRow> {
    const result = await pool.query<EventRow>(
      [
        "SELECT status, attempts,",
        " delivered_at IS NOT NULL AS acked,",
        " lease_token IS NOT NULL AS leased",
        " FROM cookie_jobs.outbox_events",
        " WHERE tenant_id=$1::uuid AND id=$2::uuid",
      ].join(""),
      [tenantId, id],
    );
    assert.equal(result.rows.length, 1, "Synthetic event must remain present");
    return result.rows[0]!;
  }

  try {
    await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
    const client = await pool.connect();
    let eventId = "";
    let unrelatedId = "";
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [identityId],
      );
      await client.query(
        [
          "INSERT INTO cookie_tenancy.organizations",
          "(id, owner_identity_id, display_name)",
          "VALUES($1::uuid, $2::uuid, 'Synthetic compiled worker CI')",
        ].join(" "),
        [tenantId, identityId],
      );
      eventId = (
        await enqueueOutbox(client, {
          tenantId,
          dedupeKey: "compiled-worker-ack-" + randomUUID(),
          topic: "test.synthetic",
          payload: { synthetic: true },
        })
      ).id;
      unrelatedId = (
        await enqueueOutbox(client, {
          tenantId,
          dedupeKey: "compiled-worker-unrelated-" + randomUUID(),
          topic: "test.unrelated",
          payload: { synthetic: true },
        })
      ).id;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // The compiled worker must fail closed when a TLS-only connection is
    // required against CI's deliberately non-TLS PostgreSQL service.
    // A process that remains alive briefly without successful DB polling
    // cannot satisfy the delivery oracle below.
    negative = startCompiledWorker("require");
    const unavailable = await within(
      negative.done,
      25_000,
      "unavailable-database worker",
    );
    assert.notEqual(
      unavailable.code,
      0,
      "Worker must fail after bounded consecutive database poll failures",
    );
    assert.match(
      negative.stderr(),
      /Synthetic outbox worker stopped after an internal failure/,
      "Expected sanitized database-poll failure, not configuration rejection",
    );
    assert.deepEqual(await snapshot(eventId), {
      status: "pending",
      attempts: 0,
      acked: false,
      leased: false,
    });

    // This process is the actual compiled JS entrypoint, launched by Node.
    // Only fixture creation and DB polling use tsx; no TS worker is imported.
    positive = startCompiledWorker("disable");
    const deadline = Date.now() + 15_000;
    let delivered: EventRow | undefined;
    while (Date.now() < deadline) {
      const row = await snapshot(eventId);
      if (row.status === "delivered") {
        delivered = row;
        break;
      }
      if (
        positive.child.exitCode !== null ||
        positive.child.signalCode !== null
      ) {
        throw new Error("Compiled worker exited before durable delivery");
      }
      await sleep(75);
    }
    assert.ok(
      delivered,
      "Compiled worker did not ACK its event before deadline",
    );
    assert.deepEqual(delivered, {
      status: "delivered",
      attempts: 1,
      acked: true,
      leased: false,
    });
    assert.deepEqual(await snapshot(unrelatedId), {
      status: "pending",
      attempts: 0,
      acked: false,
      leased: false,
    });

    positive.child.kill("SIGTERM");
    const shutdown = await within(
      positive.done,
      10_000,
      "compiled worker graceful shutdown",
    );
    assert.equal(
      shutdown.code,
      0,
      "Compiled worker must exit cleanly on SIGTERM",
    );
    assert.deepEqual(await snapshot(eventId), delivered);
    assert.deepEqual(await snapshot(unrelatedId), {
      status: "pending",
      attempts: 0,
      acked: false,
      leased: false,
    });
    process.stdout.write(
      "Compiled synthetic worker: PostgreSQL claim, ACK, topic isolation, no-DB denial and SIGTERM passed.\n",
    );
  } finally {
    for (const running of [positive, negative]) {
      if (!running) continue;
      if (
        running.child.exitCode === null &&
        running.child.signalCode === null
      ) {
        running.child.kill("SIGKILL");
      }
      await within(running.done, 5_000, "worker cleanup").catch(
        () => undefined,
      );
    }
    await pool
      .query("DELETE FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid", [
        tenantId,
      ])
      .catch(() => undefined);
    await pool
      .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [
        tenantId,
      ])
      .catch(() => undefined);
    await pool
      .query("DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [
        identityId,
      ])
      .catch(() => undefined);
    await pool.end();
  }
}

await main();
