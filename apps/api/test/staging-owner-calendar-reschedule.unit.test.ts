import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";

import { createApp } from "../src/app.js";
import { parseStagingOwnerRescheduleCutoff } from "../src/staging-owner-calendar-reschedule-http.js";

const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const location = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const booking = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const prefix = "/v1/organizations/" + tenant + "/owner-calendar";
const route = prefix + "/" + booking + "/reschedule";
const url = route + "?locationId=" + location;

test("private owner reschedule cutoff requires an explicit valid operator setting", () => {
  assert.equal(parseStagingOwnerRescheduleCutoff(undefined), undefined);
  for (const input of ["0", "1", "60", "525600"])
    assert.equal(parseStagingOwnerRescheduleCutoff(input), Number(input));
  for (const input of ["", "-1", "01", "1.2", "525601", "9999999", "5 ", "off"])
    assert.throws(() => parseStagingOwnerRescheduleCutoff(input));
});

test("owner time-move routes fail closed, validate scope and syntax before any DB access", async () => {
  let calls = 0;
  const pool = {
    query() {
      calls++;
      throw new Error("fixture database disabled");
    },
    connect() {
      calls++;
      throw new Error("fixture database disabled");
    },
  } as unknown as Pool;
  const verifier = {
    async verifyBearerToken(token: string) {
      return token === "verified-unit-token"
        ? {
            tenantId: tenant,
            identityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 90,
          }
        : null;
    },
  };
  const disabled = createApp(pool);
  const app = createApp(pool, {
    stagingOwnerCalendarReschedule: {
      pool,
      verifier,
      enabled: true,
      cutoffMinutes: 0,
    },
  });
  const headers = { authorization: "Bearer verified-unit-token" };
  const post = (
    currentUrl: string,
    body: Record<string, unknown>,
    key = "synthetic-owner-move-001",
  ) =>
    app.inject({
      method: "POST",
      url: currentUrl,
      headers: {
        ...headers,
        "idempotency-key": key,
      },
      payload: body,
    });
  try {
    for (const endpoint of [
      prefix + "/reschedule/capability",
      route + "/slots?locationId=" + location + "&localDate=2027-01-11",
      url,
    ]) {
      assert.equal(
        (await disabled.inject({ method: "GET", url: endpoint })).statusCode,
        404,
      );
    }
    for (const endpoint of [
      prefix + "/reschedule/capability",
      route + "/slots?locationId=" + location + "&localDate=2027-01-11",
    ]) {
      const response = await app.inject({ method: "GET", url: endpoint });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers.vary, "Authorization");
    }
    assert.equal(
      (await app.inject({ method: "POST", url, payload: {} })).statusCode,
      401,
    );
    for (const endpoint of [
      route + "/slots?locationId=wrong&localDate=2027-01-11",
      route + "/slots?locationId=" + location + "&localDate=2027-02-30",
      route + "/slots?locationId=" + location + "&localDate=2027-01-11&extra=1",
      route + "/slots?locationId=" + location,
      prefix +
        "/wrong/reschedule/slots?locationId=" +
        location +
        "&localDate=2027-01-11",
    ]) {
      assert.equal(
        (await app.inject({ method: "GET", url: endpoint, headers }))
          .statusCode,
        400,
      );
    }
    for (const [endpoint, body, key] of [
      [
        url + "&extra=1",
        { newStartAt: "2027-01-11T11:00:00.000Z" },
        "synthetic-owner-move-001",
      ],
      [
        route + "?locationId=wrong",
        { newStartAt: "2027-01-11T11:00:00.000Z" },
        "synthetic-owner-move-001",
      ],
      [url, { newStartAt: "2027-01-11T11:00:00Z" }, "synthetic-owner-move-001"],
      [
        url,
        { newStartAt: "2027-01-11T11:00:00.000Z", customerId: location },
        "synthetic-owner-move-001",
      ],
      [url, { newStartAt: "2027-01-11T11:00:00.000Z" }, "short"],
      [url, {}, "synthetic-owner-move-001"],
    ] as const)
      assert.equal((await post(endpoint, body, key)).statusCode, 400);
    assert.equal(
      calls,
      0,
      "Malformed/unverified requests must never query the DB",
    );
  } finally {
    await app.close();
    await disabled.close();
  }
});
