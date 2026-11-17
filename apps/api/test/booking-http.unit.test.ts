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
  const quoteUrl = `/v1/organizations/${TENANT}/locations/${LOCATION}/quote?serviceId=${SERVICE}&staffId=${STAFF}&date=2027-04-12&startAt=2027-04-12T10:00:00Z`;
  const anonymousQuote = await app.inject({
    method: "GET",
    url: quoteUrl,
    headers: { "x-tenant-id": TENANT, "x-identity-id": IDENTITY },
  });
  assert.equal(anonymousQuote.statusCode, 401);
  const wrongTenantQuote = await app.inject({
    method: "GET",
    url: quoteUrl.replace(TENANT, OTHER),
    headers: { authorization: "Bearer valid" },
  });
  assert.equal(wrongTenantQuote.statusCode, 403);
  const invalidDateQuote = await app.inject({
    method: "GET",
    url: quoteUrl.replace("date=2027-04-12", "date=2027-02-30"),
    headers: { authorization: "Bearer valid" },
  });
  assert.equal(invalidDateQuote.statusCode, 400);
  const invalidMinuteQuote = await app.inject({
    method: "GET",
    url: quoteUrl.replace("T10:00:00Z", "T10:00:30Z"),
    headers: { authorization: "Bearer valid" },
  });
  assert.equal(invalidMinuteQuote.statusCode, 400);
  assert.equal(invalidMinuteQuote.json().error.code, "INVALID_REQUEST");
});

test("booking catalog returns data only after acknowledged transaction close", async (t) => {
  for (const scenario of [
    "success",
    "begin-tag",
    "commit-tag",
    "commit-error",
    "read-error",
    "rollback-error",
  ] as const) {
    await t.test(scenario, async (t) => {
      const commands: string[] = [];
      const releases: boolean[] = [];
      const client = {
        async query(sql: string) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
            commands.push(sql);
            if (
              (sql === "COMMIT" && scenario === "commit-error") ||
              (sql === "ROLLBACK" && scenario === "rollback-error")
            ) {
              throw new Error("private SQL error");
            }
            const command =
              (sql === "BEGIN" && scenario === "begin-tag") ||
              (sql === "COMMIT" && scenario === "commit-tag")
                ? "ROLLBACK"
                : sql;
            return { command, rows: [] };
          }
          if (sql.includes("org.owner_identity_id::text")) {
            commands.push("policy");
            return {
              rows: [
                {
                  owner_identity_id: IDENTITY,
                  membership_identity_id: IDENTITY,
                  membership_active: true,
                  assignment_id: "assignment",
                  assignment_active: true,
                  assignment_location_id: null,
                  role_id: "role",
                  role_base_type: "owner",
                  role_display_name: "Owner",
                  role_permissions: ["booking.create"],
                  role_active: true,
                },
              ],
            };
          }
          if (sql.includes("FROM cookie_staff.service_assignments assignment")) {
            commands.push("catalog");
            if (scenario === "read-error" || scenario === "rollback-error") {
              throw new Error("private SQL error");
            }
            return {
              rows: [
                {
                  service_id: SERVICE,
                  service_name: "Synthetic service",
                  staff_id: STAFF,
                  staff_name: "Synthetic staff",
                  duration_minutes: 30,
                  post_service_buffer_minutes: 0,
                  price_kopecks: "10000",
                  time_zone: "UTC",
                },
              ],
            };
          }
          return { rows: [] };
        },
        release(discard: boolean) {
          releases.push(discard);
        },
      };
      const app = createApp(mockDb, {
        syntheticBookingRoutes: {
          pool: { connect: async () => client } as unknown as Pool,
          verifier: {
            verifyBearerToken: async () => ({
              tenantId: TENANT,
              identityId: IDENTITY,
              expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
            }),
          },
          assertEntitled: async () => {
            assert.fail("catalog must not invoke booking entitlement");
          },
        },
      });
      t.after(async () => app.close());

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${TENANT}/locations/${LOCATION}/catalog`,
        headers: { authorization: "Bearer valid" },
      });

      if (scenario === "success") {
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().offers[0].serviceId, SERVICE);
        assert.deepEqual(commands, ["BEGIN", "policy", "catalog", "COMMIT"]);
        assert.deepEqual(releases, [false]);
      } else {
        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.json(), {
          error: { code: "BACKEND_UNAVAILABLE" },
        });
        if (scenario === "begin-tag") {
          assert.deepEqual(commands, ["BEGIN"]);
        } else if (scenario === "read-error" || scenario === "rollback-error") {
          assert.deepEqual(commands, ["BEGIN", "policy", "catalog", "ROLLBACK"]);
        } else {
          assert.deepEqual(commands, ["BEGIN", "policy", "catalog", "COMMIT"]);
        }
        assert.deepEqual(releases, [scenario !== "read-error"]);
      }
    });
  }
});
