import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { createApp } from "../src/app.js";
import { assertStagingBookingResponse } from "./staging-booking-contract.js";

test("staging mutation parser rejects invalid transport without DB or auth calls", async () => {
  let databaseCalls = 0;
  let verifierCalls = 0;
  const pool = {
    async connect() {
      databaseCalls++;
      throw new Error("Unexpected database access");
    },
    async query() {
      databaseCalls++;
      throw new Error("Unexpected database access");
    },
  } as unknown as Pool;
  const verifier = {
    async verifyBearerToken() {
      verifierCalls++;
      return null;
    },
  };
  const dependencies = { pool, verifier, enabled: true };
  const app = createApp(pool, {
    stagingCustomerBookingRoutes: dependencies,
    stagingCustomerCancellationRoutes: { ...dependencies, cutoffMinutes: 0 },
    stagingCustomerRescheduleRoutes: { ...dependencies, cutoffMinutes: 0 },
  });
  const disabled = createApp(pool);
  const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const booking = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const routes = [
    "staging-customer-bookings",
    "staging-customer-cancellation/{bookingId}",
    "staging-customer-reschedule/{bookingId}",
  ];
  const inputs = [
    {
      contentType: "application/json",
      payload: '{"private-marker":',
      status: 400,
      error: "invalid-request",
    },
    {
      contentType: "application/json",
      payload: "",
      status: 400,
      error: "invalid-request",
    },
    {
      contentType: "application/json",
      payload: JSON.stringify({ data: "x".repeat(16_384) }),
      status: 413,
      error: "payload-too-large",
    },
    {
      contentType: "application/x-private-marker",
      payload: "private-marker",
      status: 415,
      error: "unsupported-media-type",
    },
  ];
  try {
    for (const route of routes) {
      const url =
        "/v1/organizations/" +
        tenant +
        "/" +
        route.replace("{bookingId}", booking);
      for (const input of inputs) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: {
            "content-type": input.contentType,
            authorization: "Bearer " + "cs_" + "a".repeat(43),
          },
          payload: input.payload,
        });
        assertStagingBookingResponse(route, "post", input.status, response);
        assert.deepEqual(response.json(), { error: input.error });
      }
      const validJson = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: "{}",
      });
      assertStagingBookingResponse(route, "post", 401, validJson);
      assert.deepEqual(validJson.json(), { error: "unauthorized" });
      const unmounted = await disabled.inject({
        method: "POST",
        url,
        payload: {},
      });
      assert.equal(unmounted.statusCode, 404);
    }
    assert.equal(databaseCalls, 0);
    assert.equal(verifierCalls, 0);
  } finally {
    await app.close();
    await disabled.close();
  }
});
