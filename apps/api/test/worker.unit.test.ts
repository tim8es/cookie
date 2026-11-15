import assert from "node:assert/strict";
import test from "node:test";

import {
  superviseOutboxWorker,
  type OutboxBatchResult,
  type WorkerObservation,
} from "../../../packages/platform-db/src/worker.js";

const empty: OutboxBatchResult = {
  claimed: 0,
  delivered: 0,
  failed: 0,
  stale: 0,
};

test("supervisor polls, accumulates sanitized counters and stops on abort", async () => {
  const controller = new AbortController();
  const reports: WorkerObservation[] = [];
  let calls = 0;
  const totals = await superviseOutboxWorker(
    async () => {
      calls++;
      if (calls === 3) controller.abort();
      return calls === 2
        ? { claimed: 1, delivered: 0, failed: 1, stale: 0 }
        : empty;
    },
    {
      signal: controller.signal,
      idleDelayMs: 10,
      busyDelayMs: 10,
      observe(report) {
        reports.push(report);
      },
    },
  );
  assert.deepEqual(totals, {
    claimed: 1,
    delivered: 0,
    failed: 1,
    stale: 0,
  });
  assert.equal(calls, 3);
  assert.equal(reports.at(-1)?.kind, "stopped");
  assert.equal(reports.filter((event) => event.kind === "batch").length, 3);
  assert.equal(JSON.stringify(reports).includes("payload"), false);
});

test("aborting while a handler is in flight waits for it without claiming again", async () => {
  const controller = new AbortController();
  const completion: { resolve?: () => void } = {};
  const entry: { resolve?: () => void } = {};
  let calls = 0;
  const inFlight = new Promise<void>((resolve) => { completion.resolve = resolve; });
  const entered = new Promise<void>((resolve) => { entry.resolve = resolve; });
  const resultPromise = superviseOutboxWorker(
    async () => {
      calls++;
      entry.resolve?.();
      await inFlight;
      return { claimed: 1, delivered: 1, failed: 0, stale: 0 };
    },
    { signal: controller.signal, idleDelayMs: 10, busyDelayMs: 10 },
  );
  await entered;
  controller.abort();
  assert.equal(calls, 1);
  completion.resolve?.();
  assert.deepEqual(await resultPromise, {
    claimed: 1,
    delivered: 1,
    failed: 0,
    stale: 0,
  });
});

test("transient database poll failure is retried; successful poll resets the circuit", async () => {
  const controller = new AbortController();
  let calls = 0;
  const observations: WorkerObservation[] = [];
  const result = await superviseOutboxWorker(
    async () => {
      calls++;
      if (calls === 1 || calls === 3) throw new Error("connectionString=secret");
      if (calls === 4) controller.abort();
      return empty;
    },
    {
      signal: controller.signal,
      idleDelayMs: 10,
      busyDelayMs: 10,
      maxConsecutivePollErrors: 2,
      observe: (observation) => observations.push(observation),
    },
  );
  assert.deepEqual(result, empty);
  assert.equal(calls, 4);
  assert.deepEqual(
    observations.filter((x) => x.kind === "poll-error")
      .map((x) => x.consecutivePollErrors),
    [1, 1],
  );
  assert.doesNotMatch(JSON.stringify(observations), /secret/);
});

test("consecutive polling failures stop with a sanitized error", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    superviseOutboxWorker(
      async () => {
        calls++;
        throw new Error("password=never-expose");
      },
      {
        signal: controller.signal,
        idleDelayMs: 10,
        busyDelayMs: 10,
        maxConsecutivePollErrors: 2,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /halted after repeated polling errors/);
      assert.doesNotMatch(error.message, /never-expose/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("observability callback failures cannot interrupt at-least-once delivery", async () => {
  const controller = new AbortController();
  const counts = await superviseOutboxWorker(
    async () => {
      controller.abort();
      return { claimed: 1, delivered: 1, failed: 0, stale: 0 };
    },
    {
      signal: controller.signal,
      observe: () => { throw new Error("telemetry down"); },
    },
  );
  assert.equal(counts.delivered, 1);
});

test("aborted worker does not query database, invalid delays and circuits are rejected", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await superviseOutboxWorker(
    async () => { calls++; return empty; },
    { signal: controller.signal },
  );
  assert.deepEqual(result, empty);
  assert.equal(calls, 0);
  await assert.rejects(
    superviseOutboxWorker(async () => empty, {
      signal: controller.signal,
      idleDelayMs: 0,
    }),
    /Invalid outbox supervisor configuration/,
  );
  await assert.rejects(
    superviseOutboxWorker(async () => empty, {
      signal: controller.signal,
      maxConsecutivePollErrors: 0,
    }),
    /Invalid outbox supervisor configuration/,
  );
});
