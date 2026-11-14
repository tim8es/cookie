import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";

test("liveness does not depend on database availability", async (t) => {
  const app = createApp({
    query: async () => {
      throw new Error("database offline");
    },
  });
  t.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: "/health/live" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { service: "cookie-api", status: "ok" });
});

test("readiness checks PostgreSQL rather than reporting unconditional success", async (t) => {
  let calls = 0;
  const app = createApp({
    query: async (statement) => {
      assert.equal(statement, "SELECT 1");
      calls += 1;
      return { rows: [{ "?column?": 1 }] };
    },
  });
  t.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: "/health/ready" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { service: "cookie-api", status: "ready" });
  assert.equal(calls, 1);
});

test("readiness fails closed and does not leak database errors", async (t) => {
  const app = createApp({
    query: async () => {
      throw new Error("secret=do-not-expose");
    },
  });
  t.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: "/health/ready" });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { service: "cookie-api", status: "not-ready" });
  assert.doesNotMatch(response.body, /do-not-expose/);
});

test("unknown API routes are not treated as an implemented booking endpoint", async (t) => {
  const app = createApp({ query: async () => ({ rows: [] }) });
  t.after(async () => app.close());

  const response = await app.inject({ method: "POST", url: "/v1/bookings" });
  assert.equal(response.statusCode, 404);
});
