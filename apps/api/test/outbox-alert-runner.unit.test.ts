import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import {
  superviseOutboxAlertDelivery,
  type OutboxAlertRunnerObservation,
} from "../../../packages/platform-db/src/outbox-alert-runner.js";

const lease = {
  transition_id: "123",
  revision: "4",
  code: "DUE_BACKLOG",
  kind: "raised",
  previous_severity: null,
  severity: "warning",
  attempts: 1,
  lease_token: randomUUID(),
};

/** Mock only PostgreSQL command boundaries; no provider calls or I/O. */
function fakePool(onAck?: () => void, onFail?: () => void): Pool {
  return {
    async query(sql: string): Promise<unknown> {
      if (sql.includes("last_failure_code='LEASE_EXHAUSTED'")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("WITH chosen AS")) {
        return { rowCount: 1, rows: [lease] };
      }
      if (sql.includes("SET status='delivered'")) {
        onAck?.();
        return { rowCount: 1, rows: [{ transition_id: lease.transition_id }] };
      }
      if (sql.includes("SET status=CASE")) {
        onFail?.();
        return { rowCount: 1, rows: [{ transition_id: lease.transition_id }] };
      }
      throw new Error("Unexpected internal query");
    },
  } as unknown as Pool;
}

test("stopped alert worker never claims or invokes a handler", async () => {
  const controller = new AbortController();
  controller.abort();
  const pool = {
    async query(): Promise<never> {
      assert.fail("aborted runner cannot access storage");
    },
  } as unknown as Pool;
  const result = await superviseOutboxAlertDelivery(
    pool,
    async () => assert.fail("aborted runner cannot process a lease"),
    { signal: controller.signal },
  );
  assert.deepEqual(result, {
    claimed: 0,
    acknowledged: 0,
    failed: 0,
    stale: 0,
    abandoned: 0,
  });
});

test("runner options fail closed before any storage access", async () => {
  const pool = {
    async query(): Promise<never> {
      assert.fail("invalid options cannot access database");
    },
  } as unknown as Pool;
  const handler = async (): Promise<void> => undefined;
  const signal = new AbortController().signal;
  for (const patch of [
    { leaseMs: 0 },
    { leaseMs: 600_001 },
    { handlerTimeoutMs: 0 },
    { leaseMs: 500, handlerTimeoutMs: 400 },
    { idleDelayMs: -1 },
    { busyDelayMs: 0 },
    { errorDelayMs: Infinity },
    { retryDelayMs: -1 },
    { maxConsecutiveStorageErrors: 0 },
    { maxConsecutiveStorageErrors: 21 },
  ]) {
    await assert.rejects(
      superviseOutboxAlertDelivery(pool, handler, { signal, ...patch }),
      /Invalid Outbox alert runner configuration/,
    );
  }
  await assert.rejects(
    superviseOutboxAlertDelivery(pool, undefined as never, { signal }),
    /Invalid Outbox alert runner configuration/,
  );
});

test("graceful shutdown during current task still acknowledges it, without new claims", async () => {
  const controller = new AbortController();
  let acked = 0;
  let called = 0;
  const samples: OutboxAlertRunnerObservation[] = [];
  const result = await superviseOutboxAlertDelivery(
    fakePool(() => acked++),
    async (_lease, signal) => {
      assert.equal(signal.aborted, false);
      called++;
      controller.abort();
      await Promise.resolve();
    },
    {
      signal: controller.signal,
      leaseMs: 500,
      handlerTimeoutMs: 100,
      busyDelayMs: 10,
      observe(sample) {
        samples.push(sample);
        throw new Error("observer failure is not a worker failure");
      },
    },
  );
  assert.equal(called, 1);
  assert.equal(acked, 1);
  assert.deepEqual(result, {
    claimed: 1,
    acknowledged: 1,
    failed: 0,
    stale: 0,
    abandoned: 0,
  });
  assert.deepEqual(
    samples.map((event) => event.kind),
    ["cycle", "stopped"],
  );
});

test("handler exception is sanitized into bounded retry, not logged or leaked", async () => {
  const controller = new AbortController();
  let retries = 0;
  let acknowledgements = 0;
  const result = await superviseOutboxAlertDelivery(
    fakePool(
      () => acknowledgements++,
      () => retries++,
    ),
    async () => {
      controller.abort();
      throw new Error("private phone, password and internal SQL details");
    },
    {
      signal: controller.signal,
      leaseMs: 500,
      handlerTimeoutMs: 100,
      retryDelayMs: 0,
    },
  );
  assert.deepEqual(result, {
    claimed: 1,
    acknowledged: 0,
    failed: 1,
    stale: 0,
    abandoned: 0,
  });
  assert.equal(retries, 1);
  assert.equal(acknowledgements, 0);
});

test("hanging handler times out, leaves lease unacknowledged and stops runner", async () => {
  const controller = new AbortController();
  let stoppedSignal: AbortSignal | undefined;
  let acked = 0;
  let failed = 0;
  let calls = 0;
  const observed: OutboxAlertRunnerObservation[] = [];
  await assert.rejects(
    superviseOutboxAlertDelivery(
      fakePool(
        () => acked++,
        () => failed++,
      ),
      async (_lease, signal) => {
        calls++;
        stoppedSignal = signal;
        return new Promise<void>(() => {
          // Uncooperative handler. No additional tasks may be claimed.
        });
      },
      {
        signal: controller.signal,
        leaseMs: 500,
        handlerTimeoutMs: 30,
        observe: (event) => observed.push(event),
      },
    ),
    /Outbox alert runner stopped after abandoned lease/,
  );
  assert.equal(calls, 1);
  assert.equal(acked, 0);
  assert.equal(failed, 0);
  assert.equal(stoppedSignal?.aborted, true);
  assert.equal(observed.at(-1)?.totals.abandoned, 1);
  assert.doesNotMatch(JSON.stringify(observed), /token|private|password/);
});

test("repeated database faults stop safely without leaking credentials or spinning", async () => {
  let queries = 0;
  const observed: OutboxAlertRunnerObservation[] = [];
  const pool = {
    async query(): Promise<never> {
      queries++;
      throw new Error("postgresql://private_user:private_password@db.internal");
    },
  } as unknown as Pool;
  await assert.rejects(
    superviseOutboxAlertDelivery(
      pool,
      async () => assert.fail("no lease can reach handler"),
      {
        signal: new AbortController().signal,
        leaseMs: 500,
        handlerTimeoutMs: 100,
        maxConsecutiveStorageErrors: 2,
        errorDelayMs: 10,
        observe: (event) => observed.push(event),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Outbox alert runner stopped after storage failures",
      );
      return true;
    },
  );
  assert.equal(queries, 2);
  assert.deepEqual(
    observed.map(({ kind, consecutiveStorageErrors }) => [
      kind,
      consecutiveStorageErrors,
    ]),
    [
      ["storage-error", 1],
      ["storage-error", 2],
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(observed),
    /private_user|private_password/,
  );
});
