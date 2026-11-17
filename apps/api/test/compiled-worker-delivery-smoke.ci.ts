import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import {
  acknowledgeOutbox,
  enqueueOutbox,
} from "../../../packages/platform-db/src/outbox.js";

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

/** Crash the real worker at a deliberately blocked, uncommitted ACK. */
async function verifyCrashRecovery(
  pool: Pool,
  tenantId: string,
  snapshot: (id: string) => Promise<EventRow>,
): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 18);
  const functionName = "cookie_ci_ack_" + suffix;
  const triggerName = "cookie_ci_ack_gate_" + suffix;
  const control = await pool.connect();
  let crashed: RunningWorker | undefined;
  let replacement: RunningWorker | undefined;
  let gateHeld = false;
  let functionCreated = false;
  let triggerCreated = false;
  let blockedPid: number | undefined;
  let controlPid: number | undefined;

  async function enqueue(): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const event = await enqueueOutbox(client, {
        tenantId,
        dedupeKey: "compiled-crash-" + randomUUID(),
        topic: "test.synthetic",
        payload: { synthetic: true },
      });
      await client.query("COMMIT");
      return event.id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  try {
    const id = await enqueue();
    // Session-level test barrier; the trigger acquires the same advisory
    // lock only for this generated event's delivered transition.
    await control.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      id,
    ]);
    gateHeld = true;
    controlPid = (
      await control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    await pool.query(
      `CREATE FUNCTION public.${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $cookie_gate$
        BEGIN
          IF NEW.tenant_id='${tenantId}'::uuid AND NEW.id='${id}'::uuid
             AND NEW.status='delivered' THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('${id}',0));
          END IF;
          RETURN NEW;
        END;
        $cookie_gate$`,
    );
    functionCreated = true;
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE UPDATE
        ON cookie_jobs.outbox_events
        FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`,
    );
    triggerCreated = true;
    crashed = startCompiledWorker("disable");
    const blockDeadline = Date.now() + 10_000;
    while (Date.now() < blockDeadline) {
      const blocked = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE application_name='cookie-synthetic-worker'
            AND datname=current_database() AND usename=current_user
            AND $1::integer=ANY(pg_blocking_pids(pid))`,
        [controlPid],
      );
      if (blocked.rows[0]) {
        blockedPid = blocked.rows[0].pid;
        break;
      }
      assert.equal(crashed.child.exitCode, null);
      await sleep(25);
    }
    assert.ok(blockedPid, "Actual ACK must be blocked by test barrier");
    const leased: EventRow = {
      status: "leased",
      attempts: 1,
      acked: false,
      leased: true,
    };
    assert.deepEqual(await snapshot(id), leased);
    const before = await pool.query<{ token: string; live: boolean }>(
      `SELECT lease_token::text AS token,
              lease_until>clock_timestamp() AS live
         FROM cookie_jobs.outbox_events WHERE id=$1::uuid`,
      [id],
    );
    assert.equal(before.rows[0]?.live, true);
    const staleToken = before.rows[0]!.token;

    // Kill the process while its ACK cannot commit. PostgreSQL may not
    // detect a disconnected socket while waiting on an advisory lock;
    // explicitly terminate only the observed blocked backend before
    // releasing the barrier so an orphan ACK cannot later commit.
    assert.equal(crashed.child.kill("SIGKILL"), true);
    assert.equal(
      (await within(crashed.done, 5_000, "crashed worker")).signal,
      "SIGKILL",
    );
    await pool.query(
      `SELECT pg_terminate_backend(pid,3000) FROM pg_stat_activity
        WHERE pid=$1::integer AND $2::integer=ANY(pg_blocking_pids(pid))
          AND application_name='cookie-synthetic-worker'
          AND datname=current_database() AND usename=current_user`,
      [blockedPid, controlPid],
    );
    const active = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE pid=$1::integer",
      [blockedPid],
    );
    assert.equal(active.rowCount, 0, "Blocked ACK backend must be gone");
    await control.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
      id,
    ]);
    gateHeld = false;
    await pool.query(
      `DROP TRIGGER ${triggerName} ON cookie_jobs.outbox_events`,
    );
    triggerCreated = false;
    await pool.query(`DROP FUNCTION public.${functionName}()`);
    functionCreated = false;
    assert.deepEqual(await snapshot(id), leased);

    // A replacement must process unrelated due work, but must not steal
    // this unexpired lease. No test rewrites lease_until or advances clocks.
    const sentinelId = await enqueue();
    replacement = startCompiledWorker("disable");
    const sentinelDeadline = Date.now() + 10_000;
    while (Date.now() < sentinelDeadline) {
      if ((await snapshot(sentinelId)).status === "delivered") break;
      assert.equal(replacement.child.exitCode, null);
      await sleep(50);
    }
    const delivered: EventRow = {
      status: "delivered",
      attempts: 1,
      acked: true,
      leased: false,
    };
    assert.deepEqual(await snapshot(sentinelId), delivered);
    assert.deepEqual(await snapshot(id), leased);
    const stillLive = await pool.query<{ live: boolean }>(
      `SELECT lease_until>clock_timestamp() AS live
         FROM cookie_jobs.outbox_events WHERE id=$1::uuid`,
      [id],
    );
    assert.equal(stillLive.rows[0]?.live, true);

    const expiryDeadline = Date.now() + 45_000;
    while (Date.now() < expiryDeadline) {
      assert.equal(replacement.child.exitCode, null);
      if ((await snapshot(id)).status === "delivered") break;
      await sleep(100);
    }
    const recovered = { ...delivered, attempts: 2 };
    assert.deepEqual(await snapshot(id), recovered);
    assert.equal(
      await acknowledgeOutbox(pool, { id, leaseToken: staleToken }),
      false,
      "Original fencing token must not acknowledge recovered event",
    );
    assert.deepEqual(await snapshot(id), recovered);
    assert.deepEqual(await snapshot(sentinelId), delivered);
    replacement.child.kill("SIGTERM");
    assert.equal(
      (await within(replacement.done, 10_000, "replacement shutdown")).code,
      0,
    );
    process.stdout.write(
      "PASS: killed compiled worker; uncommitted ACK rolled back; replacement recovered after real lease expiry.\n",
    );
  } finally {
    for (const running of [replacement, crashed]) {
      if (!running) continue;
      if (
        running.child.exitCode === null &&
        running.child.signalCode === null
      ) {
        running.child.kill("SIGKILL");
      }
      await within(running.done, 5_000, "crash worker cleanup").catch(
        () => undefined,
      );
    }
    // If a failed assertion left an ACK blocked, remove that backend
    // before letting the advisory lock go.
    try {
      if (gateHeld) {
        if (controlPid !== undefined) {
          await pool.query(
            `SELECT pg_terminate_backend(pid,3000) FROM pg_stat_activity
              WHERE application_name='cookie-synthetic-worker'
                AND datname=current_database() AND usename=current_user
                AND $1::integer=ANY(pg_blocking_pids(pid))`,
            [controlPid],
          );
        }
        await control.query("SELECT pg_advisory_unlock_all()");
      }
      if (triggerCreated) {
        await pool.query(
          `DROP TRIGGER IF EXISTS ${triggerName} ON cookie_jobs.outbox_events`,
        );
      }
      if (functionCreated) {
        await pool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
      }
    } finally {
      control.release();
    }
  }
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

    // Break the actual established PostgreSQL connection, not the worker
    // process. The CI DB is isolated and the earlier worker has exited.
    // Terminate only a backend owned by this synthetic worker, never an
    // arbitrary connection or the fixture's own control session.
    let terminatedPid: number | undefined;
    const faultDeadline = Date.now() + 5_000;
    while (Date.now() < faultDeadline) {
      const killed = await pool.query<{ pid: number; killed: boolean }>(
        `SELECT pid, pg_terminate_backend(pid, 3000) AS killed
           FROM pg_stat_activity
          WHERE datname=current_database()
            AND usename=current_user
            AND application_name='cookie-synthetic-worker'
            AND backend_type='client backend'
            AND state='idle' AND pid<>pg_backend_pid()
          ORDER BY pid LIMIT 1`,
      );
      if (killed.rows[0]?.killed) {
        terminatedPid = killed.rows[0].pid;
        break;
      }
      await sleep(25);
    }
    assert.ok(terminatedPid, "Expected a real terminated worker backend");
    const observedDeadline = Date.now() + 5_000;
    while (
      !positive
        .stderr()
        .includes("Synthetic outbox worker idle connection lost") &&
      Date.now() < observedDeadline
    ) {
      assert.equal(positive.child.exitCode, null);
      assert.equal(positive.child.signalCode, null);
      await sleep(25);
    }
    assert.match(
      positive.stderr(),
      /Synthetic outbox worker idle connection lost/,
      "Expected the actual idle-client error, not an unrelated process exit",
    );
    const afterDisconnect = await snapshot(eventId);
    assert.deepEqual(afterDisconnect, delivered);

    const recoveryClient = await pool.connect();
    let recoveryId = "";
    try {
      await recoveryClient.query("BEGIN");
      recoveryId = (
        await enqueueOutbox(recoveryClient, {
          tenantId,
          dedupeKey: "compiled-worker-recovery-" + randomUUID(),
          topic: "test.synthetic",
          payload: { synthetic: true },
        })
      ).id;
      await recoveryClient.query("COMMIT");
    } catch (error) {
      await recoveryClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      recoveryClient.release();
    }

    const recoveryDeadline = Date.now() + 15_000;
    let recovered: EventRow | undefined;
    while (Date.now() < recoveryDeadline) {
      assert.equal(positive.child.exitCode, null);
      assert.equal(positive.child.signalCode, null);
      const row = await snapshot(recoveryId);
      if (row.status === "delivered") {
        recovered = row;
        break;
      }
      await sleep(75);
    }
    assert.deepEqual(recovered, {
      status: "delivered",
      attempts: 1,
      acked: true,
      leased: false,
    });
    const backends = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname=current_database()
          AND application_name='cookie-synthetic-worker'
          AND backend_type='client backend'`,
    );
    assert.ok(backends.rows.length > 0, "Worker did not reconnect");
    assert.ok(
      backends.rows.every((row) => row.pid !== terminatedPid),
      "Terminated backend must not survive",
    );
    assert.deepEqual(await snapshot(eventId), delivered);
    assert.deepEqual(await snapshot(unrelatedId), {
      status: "pending",
      attempts: 0,
      acked: false,
      leased: false,
    });
    process.stdout.write(
      "PASS: compiled worker recovered a terminated PostgreSQL connection and acknowledged the next event once.\n",
    );

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
    assert.deepEqual(await snapshot(recoveryId), recovered);
    assert.deepEqual(await snapshot(unrelatedId), {
      status: "pending",
      attempts: 0,
      acked: false,
      leased: false,
    });
    await verifyCrashRecovery(pool, tenantId, snapshot);
    assert.deepEqual(await snapshot(eventId), delivered);
    assert.deepEqual(await snapshot(recoveryId), recovered);
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
