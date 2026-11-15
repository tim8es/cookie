import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import {
  renewOutboxAlertDeliveryLease,
  replayDeadOutboxAlertDelivery,
  type ReplayDeadAlertRequest,
} from "../../../packages/platform-db/src/outbox-alert-operations.js";

test("alert operator replay requires trusted identity, bounded metadata and explicit auth port", async () => {
  const pool = {
    async connect(): Promise<never> {
      assert.fail("invalid replay metadata must not open a transaction");
    },
  } as unknown as Pool;
  const valid: ReplayDeadAlertRequest = {
    operator: {
      identityId: randomUUID(),
      correlationId: "synthetic-operator",
    },
    transitionId: "123",
    idempotencyKey: "controlled-replay-key",
  };
  const allow = async (): Promise<void> => undefined;
  for (const input of [
    { ...valid, operator: { ...valid.operator, identityId: "unknown" } },
    { ...valid, operator: { ...valid.operator, correlationId: "" } },
    { ...valid, operator: { ...valid.operator, correlationId: "line\nfeed" } },
    {
      ...valid,
      operator: { ...valid.operator, correlationId: "a".repeat(129) },
    },
    { ...valid, transitionId: "0" },
    { ...valid, transitionId: "9223372036854775808" },
    { ...valid, transitionId: "123); DROP TABLE x;" },
    { ...valid, idempotencyKey: "" },
    { ...valid, idempotencyKey: "a".repeat(129) },
  ]) {
    await assert.rejects(
      replayDeadOutboxAlertDelivery(pool, input, allow),
      /Invalid trusted alert replay metadata/,
    );
  }
  await assert.rejects(
    replayDeadOutboxAlertDelivery(pool, valid, undefined as never),
    /Invalid trusted alert replay metadata/,
    "there is intentionally no default authorization policy for global ops",
  );
});

test("alert lease renewal validates fencing token, transition id and extension before SQL", async () => {
  const pool = {
    async query(): Promise<never> {
      assert.fail("invalid renewal must not issue SQL");
    },
  } as unknown as Pool;
  const valid = { transitionId: "456", leaseToken: randomUUID() };
  for (const [lease, extendMs] of [
    [{ ...valid, transitionId: "-1" }, 500],
    [{ ...valid, transitionId: "9223372036854775808" }, 500],
    [{ ...valid, leaseToken: "untrusted" }, 500],
    [valid, -1],
    [valid, 0],
    [valid, 600_001],
    [valid, Number.NaN],
    [valid, 0.5],
  ] as const) {
    await assert.rejects(
      renewOutboxAlertDeliveryLease(pool, lease, extendMs),
      /Invalid Outbox alert lease renewal/,
    );
  }
});
