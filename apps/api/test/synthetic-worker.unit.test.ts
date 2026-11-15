import assert from "node:assert/strict";
import test from "node:test";

import {
  idempotentProviderHandler,
  type ProviderDelivery,
} from "../../../packages/platform-db/src/delivery-port.js";
import type { OutboxLease } from "../../../packages/platform-db/src/outbox.js";
import { parseSyntheticWorkerConfig } from "../src/synthetic-worker-config.js";

const ci = "postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci";
const dev = "postgres://cookie_dev:cookie_dev@127.0.0.1:5432/cookie_dev";

test("synthetic worker fails closed except explicit local/CI test DB", () => {
  assert.throws(
    () => parseSyntheticWorkerConfig({ DATABASE_URL: ci }),
    /Synthetic worker/,
  );
  assert.throws(
    () =>
      parseSyntheticWorkerConfig({
        COOKIE_SYNTHETIC_WORKER: "enabled",
        DATABASE_URL: "postgres://prod:password@remote-host:5432/prod",
      }),
    /Synthetic worker/,
  );
  assert.throws(
    () =>
      parseSyntheticWorkerConfig({
        COOKIE_SYNTHETIC_WORKER: "enabled",
        DATABASE_URL: ci,
        CI: "true",
        TEST_DATABASE_URL: dev,
      }),
    /Synthetic worker/,
  );
  assert.deepEqual(
    parseSyntheticWorkerConfig({
      COOKIE_SYNTHETIC_WORKER: "enabled",
      DATABASE_URL: ci,
      CI: "true",
      TEST_DATABASE_URL: ci,
    }),
    { databaseUrl: ci },
  );
  assert.deepEqual(
    parseSyntheticWorkerConfig({
      COOKIE_SYNTHETIC_WORKER: "enabled",
      DATABASE_URL: dev,
    }),
    { databaseUrl: dev },
  );
});

test("idempotent provider port preserves stable key through retries and replay", async () => {
  const deliveries: ProviderDelivery[] = [];
  const handler = idempotentProviderHandler({
    supportsIdempotencyKey: true,
    async send(delivery) {
      deliveries.push(delivery);
    },
  });
  const original: OutboxLease = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    topic: "test.synthetic",
    payload: { synthetic: true },
    attempts: 1,
    leaseToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  await handler(original);
  await handler({
    ...original,
    attempts: 2,
    leaseToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  });
  await handler({
    ...original,
    attempts: 1,
    leaseToken: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  assert.equal(deliveries.length, 3);
  assert.deepEqual(
    deliveries.map((delivery) => delivery.idempotencyKey),
    ["outbox:" + original.id, "outbox:" + original.id, "outbox:" + original.id],
  );
  assert.equal(deliveries[0]?.tenantId, original.tenantId);
  assert.equal(deliveries[0]?.topic, original.topic);
  assert.throws(
    () =>
      idempotentProviderHandler({
        supportsIdempotencyKey: false,
        async send() {},
      } as unknown as Parameters<typeof idempotentProviderHandler>[0]),
    /stable idempotency key/,
  );
});
