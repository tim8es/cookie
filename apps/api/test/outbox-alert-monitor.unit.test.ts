import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyOutboxAlertState,
  reconcileOutboxAlerts,
  superviseOutboxHealth,
  type OutboxAlertTransition,
} from "../../../packages/platform-db/src/outbox-alert-monitor.js";
import {
  evaluateOutboxHealth,
  type OutboxHealthPolicy,
  type OutboxHealthSnapshot,
} from "../../../packages/platform-db/src/outbox-health.js";
import type { OutboxQueueMetrics } from "../../../packages/platform-db/src/worker.js";

const policy: OutboxHealthPolicy = {
  due: { warning: 0, critical: 3 },
  oldestDueSeconds: { warning: 100, critical: 500 },
  expiredLeases: { warning: 0, critical: 1 },
  dead: { warning: 0, critical: 0 },
};
const empty: OutboxQueueMetrics = {
  pending: 0,
  due: 0,
  leased: 0,
  expiredLeases: 0,
  delivered: 0,
  dead: 0,
  oldestDueSeconds: 0,
};
const healthy = evaluateOutboxHealth(empty, policy);
const warning = evaluateOutboxHealth({ ...empty, pending: 1, due: 1 }, policy);
const critical = evaluateOutboxHealth({ ...empty, pending: 4, due: 4 }, policy);
const outage: OutboxHealthSnapshot = {
  status: "unavailable",
  findings: [{ code: "METRICS_UNAVAILABLE", severity: "critical" }],
};

test("unchanged warning emits exactly one alert until severity changes", () => {
  const raised = reconcileOutboxAlerts(emptyOutboxAlertState(), warning);
  assert.deepEqual(raised.transitions, [
    { kind: "raised", code: "DUE_BACKLOG", severity: "warning" },
  ]);
  const repeated = reconcileOutboxAlerts(raised.state, warning);
  assert.deepEqual(repeated.transitions, []);
  const escalated = reconcileOutboxAlerts(repeated.state, critical);
  assert.deepEqual(escalated.transitions, [
    {
      kind: "escalated",
      code: "DUE_BACKLOG",
      previousSeverity: "warning",
      severity: "critical",
    },
  ]);
  const reduced = reconcileOutboxAlerts(escalated.state, warning);
  assert.deepEqual(reduced.transitions, [
    {
      kind: "deescalated",
      code: "DUE_BACKLOG",
      previousSeverity: "critical",
      severity: "warning",
    },
  ]);
  const recovered = reconcileOutboxAlerts(reduced.state, healthy);
  assert.deepEqual(recovered.transitions, [
    { kind: "resolved", code: "DUE_BACKLOG", previousSeverity: "warning" },
  ]);
  assert.deepEqual(recovered.state, emptyOutboxAlertState());
  assert.deepEqual(
    reconcileOutboxAlerts(recovered.state, healthy).transitions,
    [],
  );
  assert.equal(raised.state.active.DUE_BACKLOG, "warning");
});

test("database outage retains last known queue alerts and never invents recovery", () => {
  const raised = reconcileOutboxAlerts(emptyOutboxAlertState(), warning);
  const firstOutage = reconcileOutboxAlerts(raised.state, outage);
  assert.deepEqual(firstOutage.transitions, [
    { kind: "raised", code: "METRICS_UNAVAILABLE", severity: "critical" },
  ]);
  assert.deepEqual(firstOutage.state.active, {
    DUE_BACKLOG: "warning",
    METRICS_UNAVAILABLE: "critical",
  });
  const repeated = reconcileOutboxAlerts(firstOutage.state, outage);
  assert.deepEqual(repeated.transitions, []);
  const returned = reconcileOutboxAlerts(repeated.state, warning);
  assert.deepEqual(returned.transitions, [
    {
      kind: "resolved",
      code: "METRICS_UNAVAILABLE",
      previousSeverity: "critical",
    },
  ]);
  assert.equal(returned.state.active.DUE_BACKLOG, "warning");

  const fullyRecovered = reconcileOutboxAlerts(firstOutage.state, healthy);
  assert.deepEqual(fullyRecovered.transitions, [
    { kind: "resolved", code: "DUE_BACKLOG", previousSeverity: "warning" },
    {
      kind: "resolved",
      code: "METRICS_UNAVAILABLE",
      previousSeverity: "critical",
    },
  ]);
});

test("two simultaneous reasons independently raise and resolve in stable order", () => {
  const mixed = evaluateOutboxHealth(
    { ...empty, pending: 1, due: 1, dead: 1 },
    policy,
  );
  const first = reconcileOutboxAlerts(emptyOutboxAlertState(), mixed);
  assert.deepEqual(first.transitions, [
    { kind: "raised", code: "DUE_BACKLOG", severity: "warning" },
    { kind: "raised", code: "DEAD_LETTERS", severity: "critical" },
  ]);
  const second = reconcileOutboxAlerts(first.state, warning);
  assert.deepEqual(second.transitions, [
    {
      kind: "resolved",
      code: "DEAD_LETTERS",
      previousSeverity: "critical",
    },
  ]);
});

test("malformed or contradictory snapshots fail before mutating alert state", () => {
  const existing = reconcileOutboxAlerts(
    emptyOutboxAlertState(),
    warning,
  ).state;
  const invalid = [
    {
      status: "healthy",
      findings: [{ code: "DUE_BACKLOG", severity: "warning" }],
      metrics: empty,
    },
    {
      status: "degraded",
      findings: [
        { code: "DUE_BACKLOG", severity: "warning" },
        { code: "DUE_BACKLOG", severity: "warning" },
      ],
      metrics: empty,
    },
    {
      status: "critical",
      findings: [{ code: "METRICS_UNAVAILABLE", severity: "critical" }],
      metrics: empty,
    },
    {
      status: "unavailable",
      findings: [{ code: "METRICS_UNAVAILABLE", severity: "warning" }],
    },
    {
      status: "unavailable",
      findings: [{ code: "METRICS_UNAVAILABLE", severity: "critical" }],
      metrics: empty,
    },
  ];
  for (const sample of invalid) {
    assert.throws(
      () =>
        reconcileOutboxAlerts(
          existing,
          sample as unknown as OutboxHealthSnapshot,
        ),
      /Invalid outbox alert snapshot/,
    );
  }
  assert.deepEqual(existing.active, { DUE_BACKLOG: "warning" });
});

test("supervisor polls sequentially, deduplicates changes and terminates on AbortSignal", async () => {
  const controller = new AbortController();
  const states = [warning, warning, critical, outage, outage, healthy];
  const observed: string[] = [];
  const changes: OutboxAlertTransition[] = [];
  let activeCalls = 0;
  let maxCalls = 0;
  let sampled = 0;
  const final = await superviseOutboxHealth({
    signal: controller.signal,
    intervalMs: 10,
    sampleTimeoutMs: 200,
    maxConsecutiveUnavailable: 4,
    async sample() {
      activeCalls++;
      maxCalls = Math.max(maxCalls, activeCalls);
      const next = states[sampled++];
      await Promise.resolve();
      activeCalls--;
      assert.ok(next);
      return next;
    },
    onTransition(change) {
      changes.push(change);
      throw new Error("untrusted observer failure must be ignored");
    },
    onSample(status) {
      observed.push(status);
      if (observed.length === states.length) controller.abort();
    },
  });
  assert.equal(maxCalls, 1);
  assert.equal(sampled, 6);
  assert.deepEqual(observed, [
    "degraded",
    "degraded",
    "critical",
    "unavailable",
    "unavailable",
    "healthy",
  ]);
  assert.deepEqual(
    changes.map(({ kind, code }) => [kind, code]),
    [
      ["raised", "DUE_BACKLOG"],
      ["escalated", "DUE_BACKLOG"],
      ["raised", "METRICS_UNAVAILABLE"],
      ["resolved", "DUE_BACKLOG"],
      ["resolved", "METRICS_UNAVAILABLE"],
    ],
  );
  assert.deepEqual(final.active, {});
});

test("repeated unavailable database returns halt with bounded, non-leaking error", async () => {
  const controller = new AbortController();
  const changes: OutboxAlertTransition[] = [];
  let sampled = 0;
  await assert.rejects(
    superviseOutboxHealth({
      signal: controller.signal,
      intervalMs: 10,
      sampleTimeoutMs: 200,
      maxConsecutiveUnavailable: 3,
      async sample() {
        sampled++;
        return outage;
      },
      onTransition(change) {
        changes.push(change);
      },
    }),
    /Outbox health monitor stopped after repeated unavailability/,
  );
  assert.equal(sampled, 3);
  assert.deepEqual(changes, [
    { kind: "raised", code: "METRICS_UNAVAILABLE", severity: "critical" },
  ]);
});

test("hanging sampler times out once, without overlapping requests or disclosing secrets", async () => {
  const controller = new AbortController();
  let sampled = 0;
  const secrets = "private_password_in_db_url";
  await assert.rejects(
    superviseOutboxHealth({
      signal: controller.signal,
      intervalMs: 10,
      sampleTimeoutMs: 20,
      async sample() {
        sampled++;
        return new Promise<OutboxHealthSnapshot>(() => {
          // Deliberately unresolved (the monitor cannot cancel DB I/O).
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Outbox health sampling stopped/);
      assert.doesNotMatch(error.message, new RegExp(secrets));
      return true;
    },
  );
  assert.equal(sampled, 1);
});

test("abort while sample is in-flight suppresses late alerts and future polls", async () => {
  const controller = new AbortController();
  let called = 0;
  const result = await superviseOutboxHealth({
    signal: controller.signal,
    intervalMs: 10,
    sampleTimeoutMs: 200,
    async sample() {
      called++;
      controller.abort();
      return warning;
    },
    onTransition() {
      assert.fail("aborted sampler must not publish alert transitions");
    },
  });
  assert.equal(called, 1);
  assert.deepEqual(result, emptyOutboxAlertState());
});

test("already aborted monitor starts no sampler or timers", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  const result = await superviseOutboxHealth({
    signal: controller.signal,
    async sample() {
      called++;
      return warning;
    },
  });
  assert.equal(called, 0);
  assert.deepEqual(result.active, {});
});

test("invalid supervisor config is rejected before calling the sampler", async () => {
  let called = 0;
  const sample = async (): Promise<OutboxHealthSnapshot> => {
    called++;
    return healthy;
  };
  for (const patch of [
    { intervalMs: 0 },
    { intervalMs: 60_001 },
    { intervalMs: 20.5 },
    { sampleTimeoutMs: Number.NaN },
    { maxConsecutiveUnavailable: 0 },
    { maxConsecutiveUnavailable: 21 },
  ]) {
    await assert.rejects(
      superviseOutboxHealth({
        signal: new AbortController().signal,
        sample,
        ...patch,
      }),
      /Invalid outbox health monitor configuration/,
    );
  }
  assert.equal(called, 0);
});

test("sample rejection is sanitized and safe observer exceptions are ignored", async () => {
  const controller = new AbortController();
  let sampled = 0;
  await assert.rejects(
    superviseOutboxHealth({
      signal: controller.signal,
      sampleTimeoutMs: 100,
      intervalMs: 10,
      async sample() {
        sampled++;
        throw new Error("connection pg://user:secret@host private tenant");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Outbox health sampling stopped");
      return true;
    },
  );
  assert.equal(sampled, 1);

  const stop = new AbortController();
  const final = await superviseOutboxHealth({
    signal: stop.signal,
    sampleTimeoutMs: 100,
    intervalMs: 10,
    async sample() {
      return warning;
    },
    onTransition() {
      throw new Error("observer down");
    },
    onSample() {
      stop.abort();
      throw new Error("observer down");
    },
  });
  assert.equal(final.active.DUE_BACKLOG, "warning");
});
