import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { createApp } from "../src/app.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOKING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base = `/v1/organizations/${TENANT}/bookings/${BOOKING}`;
const mockDatabase = { query: async () => ({ rows: [] }) };

test("business mutation endpoints are absent without explicit trusted adapters", async (t) => {
  const app = createApp(mockDatabase);
  t.after(async () => app.close());
  for (const suffix of ["cancel", "reschedule"]) {
    const response = await app.inject({ method: "POST", url: `${base}/${suffix}` });
    assert.equal(response.statusCode, 404);
  }
});

test("business mutation HTTP adapter fails closed on absent, invalid, cross-tenant sessions and forged mutations", async (t) => {
  let policyInvocations = 0;
  let verifierCalls = 0;
  const app = createApp(mockDatabase, {
    syntheticBookingMutations: {
      pool: {} as Pool,
      verifier: {
        verifyBearerToken: async (token) => {
          verifierCalls++;
          if (token !== "synthetic") return null;
          return {
            tenantId: TENANT,
            identityId: IDENTITY,
            expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
          };
        },
      },
      assertMayCancel: async () => { policyInvocations++; },
      assertMayReschedule: async () => { policyInvocations++; },
    },
  });
  t.after(async () => app.close());

  for (const suffix of ["cancel", "reschedule"]) {
    const anonymous = await app.inject({ method: "POST", url: `${base}/${suffix}` });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().error.code, "UNAUTHENTICATED");

    const crossTenant = await app.inject({
      method: "POST",
      url: `/v1/organizations/${OTHER_TENANT}/bookings/${BOOKING}/${suffix}`,
      headers: { authorization: "Bearer synthetic", "idempotency-key": "same" },
      payload: suffix === "cancel" ? {} : { newStartAt: "2027-04-12T14:00:00Z" },
    });
    assert.equal(crossTenant.statusCode, 403);
    assert.equal(crossTenant.json().error.code, "ACCESS_DENIED");

    const invalidSession = await app.inject({
      method: "POST",
      url: `${base}/${suffix}`,
      headers: { authorization: "Bearer untrusted", "idempotency-key": "same" },
      payload: suffix === "cancel" ? {} : { newStartAt: "2027-04-12T14:00:00Z" },
    });
    assert.equal(invalidSession.statusCode, 401);
  }
  assert.equal(verifierCalls, 4);
  const headers = { authorization: "Bearer synthetic", "idempotency-key": "once" };
  for (const payload of [null, { staffId: IDENTITY }, { status: "CancelledByBusiness" }, { priceKopecks: "0" }]) {
    const response = await app.inject({
      method: "POST",
      url: base + "/cancel",
      headers,
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_REQUEST");
  }
  for (const payload of [
    {},
    { newStartAt: "2027-04-12T14:00:00+03:00" },
    { newStartAt: "2027-04-12T14:00:00Z", staffId: IDENTITY },
    { newStartAt: "invalid" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: base + "/reschedule",
      headers,
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_REQUEST");
  }
  for (const suffix of ["cancel", "reschedule"]) {
    const response = await app.inject({
      method: "POST",
      url: `${base}/${suffix}`,
      headers: { authorization: "Bearer synthetic" },
      payload: suffix === "cancel" ? {} : { newStartAt: "2027-04-12T14:00:00Z" },
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(policyInvocations, 0);
});
