import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { createApp } from "../src/app.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOCATION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CUSTOMER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const path = `/v1/organizations/${TENANT}/bookings`;
const mockDb = { query: async () => ({ rows: [] }) };

test("booking routes are absent from ordinary production composition", async (t) => {
  const app = createApp(mockDb);
  t.after(async () => app.close());
  for (const url of [
    path,
    `/v1/organizations/${TENANT}/locations/${LOCATION}/quote?serviceId=${SERVICE}&staffId=${STAFF}&date=2027-04-12&startAt=2027-04-12T10:00:00Z`,
    `/v1/organizations/${TENANT}/locations/${LOCATION}/catalog`,
  ]) {
    const response = await app.inject({
      method: url === path ? "POST" : "GET",
      url,
    });
    assert.equal(response.statusCode, 404);
  }
});

test("opt-in booking adapter requires verified actor, rejects forged tenant and price", async (t) => {
  let verifierCalls = 0;
  const app = createApp(mockDb, {
    syntheticBookingRoutes: {
      pool: {} as Pool,
      verifier: {
        verifyBearerToken: async (token) => {
          verifierCalls++;
          if (token === "invalid") return null;
          return {
            tenantId: TENANT,
            identityId: IDENTITY,
            expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
          };
        },
      },
      assertEntitled: async () => {
        throw new Error("must not reach entitlement on an invalid request");
      },
    },
  });
  t.after(async () => app.close());
  const body = {
    customerId: CUSTOMER,
    locationId: LOCATION,
    staffId: STAFF,
    serviceId: SERVICE,
    startAt: "2027-04-12T10:00:00Z",
  };
  const unauthenticated = await app.inject({
    method: "POST",
    url: path,
    payload: body,
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, "UNAUTHENTICATED");
  assert.equal(verifierCalls, 0);

  const wrongTenant = await app.inject({
    method: "POST",
    url: `/v1/organizations/${OTHER}/bookings`,
    headers: { authorization: "Bearer valid" },
    payload: body,
  });
  assert.equal(wrongTenant.statusCode, 403);
  assert.equal(wrongTenant.json().error.code, "ACCESS_DENIED");

  const invalid = await app.inject({
    method: "POST",
    url: path,
    headers: { authorization: "Bearer invalid", "idempotency-key": "same" },
    payload: body,
  });
  assert.equal(invalid.statusCode, 401);

  const badBodies = [
    { ...body, tenantId: TENANT },
    { ...body, priceKopecks: "0" },
    { ...body, status: "Confirmed" },
    { ...body, startAt: "2027-04-12T10:00:00+03:00" },
    { ...body, customerId: "not-a-uuid" },
  ];
  for (const payload of badBodies) {
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Bearer valid", "idempotency-key": "key" },
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_REQUEST");
  }
  const noKey = await app.inject({
    method: "POST",
    url: path,
    headers: { authorization: "Bearer valid" },
    payload: body,
  });
  assert.equal(noKey.statusCode, 400);
});

test("opt-in synthetic Quote rejects anonymous, cross-tenant and malformed requests before SQL", async (t) => {
  const app = createApp(mockDb, {
    syntheticBookingRoutes: {
      pool: {} as Pool,
      verifier: {
        verifyBearerToken: async () => ({
          tenantId: TENANT,
          identityId: IDENTITY,
          expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
        }),
      },
      assertEntitled: async () => {
        throw new Error("Quote must not invoke Booking entitlement");
      },
    },
  });
  t.after(async () => app.close());
  const quote = `/v1/organizations/${TENANT}/locations/${LOCATION}/quote?serviceId=${SERVICE}&staffId=${STAFF}&date=2027-04-12&startAt=2027-04-12T10:00:00Z`;
  const cases = [
    { url: quote, headers: {}, status: 401, code: "UNAUTHENTICATED" },
    { url: quote.replace(TENANT, OTHER), headers: { authorization: "Bearer valid" }, status: 403, code: "ACCESS_DENIED" },
    { url: quote.replace("date=2027-04-12", "date=2027-02-30"), headers: { authorization: "Bearer valid" }, status: 400, code: "INVALID_REQUEST" },
    { url: quote.replace("T10:00:00Z", "T10:00:30Z"), headers: { authorization: "Bearer valid" }, status: 400, code: "INVALID_REQUEST" },
    { url: quote.replace(`staffId=${STAFF}`, "staffId=not-uuid"), headers: { authorization: "Bearer valid" }, status: 400, code: "INVALID_REQUEST" },
  ];
  for (const { url, headers, status, code } of cases) {
    const response = await app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error.code, code);
  }
});
