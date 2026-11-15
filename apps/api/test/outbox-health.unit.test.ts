import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  evaluateOutboxHealth,
  sampleOutboxHealth,
  validateOutboxHealthPolicy,
  type OutboxHealthPolicy,
} from "../../../packages/platform-db/src/outbox-health.js";
import type { OutboxQueueMetrics } from "../../../packages/platform-db/src/worker.js";

const policy: OutboxHealthPolicy = {
  due: { warning: 2, critical: 5 },
  oldestDueSeconds: { warning: 60, critical: 300 },
  expiredLeases: { warning: 0, critical: 2 },
  dead: { warning: 0, critical: 1 },
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

test("outbox health is healthy on empty queue and at warning boundaries", () => {
  assert.deepEqual(evaluateOutboxHealth(empty, policy), {
    status: "healthy",
    findings: [],
    metrics: empty,
  });
  const exact = {
    ...empty,
    pending: 2,
    due: 2,
    oldestDueSeconds: 60,
  };
  assert.equal(evaluateOutboxHealth(exact, policy).status, "healthy");
});

test("outbox health reports deterministic warning and strict critical levels", () => {
  const warning = evaluateOutboxHealth(
    {
      ...empty,
      pending: 4,
      due: 3,
      oldestDueSeconds: 61,
      leased: 1,
      expiredLeases: 1,
      dead: 1,
    },
    policy,
  );
  assert.equal(warning.status, "degraded");
  assert.deepEqual(warning.findings, [
    { code: "DUE_BACKLOG", severity: "warning" },
    { code: "OLDEST_DUE", severity: "warning" },
    { code: "EXPIRED_LEASES", severity: "warning" },
    { code: "DEAD_LETTERS", severity: "warning" },
  ]);

  const critical = evaluateOutboxHealth(
    {
      ...empty,
      pending: 6,
      due: 6,
      oldestDueSeconds: 301,
      leased: 3,
      expiredLeases: 3,
      dead: 2,
    },
    policy,
  );
  assert.equal(critical.status, "critical");
  assert.deepEqual(
    critical.findings.map((entry) => entry.severity),
    ["critical", "critical", "critical", "critical"],
  );
});

test("critical risk dominates warnings without suppressing reason codes", () => {
  const result = evaluateOutboxHealth(
    {
      ...empty,
      pending: 3,
      due: 3,
      leased: 3,
      expiredLeases: 3,
    },
    policy,
  );
  assert.equal(result.status, "critical");
  assert.deepEqual(result.findings, [
    { code: "DUE_BACKLOG", severity: "warning" },
    { code: "EXPIRED_LEASES", severity: "critical" },
  ]);
});

test("operator thresholds support immediate first-event alert with zero values", () => {
  const zero: OutboxHealthPolicy = {
    due: { warning: 0, critical: 0 },
    oldestDueSeconds: { warning: 0, critical: 0 },
    expiredLeases: { warning: 0, critical: 0 },
    dead: { warning: 0, critical: 0 },
  };
  assert.equal(
    evaluateOutboxHealth(
      { ...empty, pending: 1, due: 1, oldestDueSeconds: 1 },
      zero,
    ).status,
    "critical",
  );
});

test("outbox health validates every threshold pair, never installs defaults", () => {
  const invalid = [
    { due: { warning: -1, critical: 2 } },
    { dead: { warning: 2, critical: 1 } },
    { expiredLeases: { warning: 0.5, critical: 2 } },
    { oldestDueSeconds: { warning: Infinity, critical: Infinity } },
    { due: { warning: Number.NaN, critical: 4 } },
  ];
  for (const patch of invalid) {
    const malformed = { ...policy, ...patch };
    assert.throws(
      () => validateOutboxHealthPolicy(malformed),
      /Invalid outbox health thresholds/,
    );
  }
  assert.throws(
    () =>
      validateOutboxHealthPolicy(undefined as unknown as OutboxHealthPolicy),
    /policy required/,
  );
});

test("inconsistent or malformed aggregate metrics never produce a healthy result", () => {
  const invalid: OutboxQueueMetrics[] = [
    { ...empty, due: 1, pending: 0 },
    { ...empty, leased: 0, expiredLeases: 1 },
    { ...empty, pending: -1 },
    { ...empty, dead: Number.NaN },
    { ...empty, oldestDueSeconds: Infinity },
    { ...empty, oldestDueSeconds: -0.1 },
    { ...empty, pending: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const metrics of invalid) {
    assert.throws(
      () => evaluateOutboxHealth(metrics, policy),
      /Invalid outbox health aggregate metrics/,
    );
  }
});

test("database outage is classified unavailable with no leaked SQL, connection string or tenant", async () => {
  const secrets = "postgresql://internal_user:secret@db.internal:5432/cookie";
  const fakePool = {
    async query(): Promise<never> {
      throw new Error("SQL_ERROR private tenant 123 " + secrets);
    },
  } as unknown as Pool;

  const result = await sampleOutboxHealth(fakePool, policy);
  assert.deepEqual(result, {
    status: "unavailable",
    findings: [{ code: "METRICS_UNAVAILABLE", severity: "critical" }],
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /private tenant|internal_user|secret/,
  );
});

test("invalid operator policy is never mislabeled as a database outage", async () => {
  let queried = false;
  const fakePool = {
    async query(): Promise<never> {
      queried = true;
      throw new Error("Query must not run");
    },
  } as unknown as Pool;
  await assert.rejects(
    sampleOutboxHealth(fakePool, {
      ...policy,
      dead: { warning: 4, critical: 3 },
    }),
    /Invalid outbox health thresholds: dead/,
  );
  assert.equal(queried, false);
});
