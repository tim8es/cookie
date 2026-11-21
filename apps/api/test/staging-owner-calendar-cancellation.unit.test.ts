import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";

import { createApp } from "../src/app.js";
import { parseStagingOwnerCancellationCutoff } from "../src/staging-owner-calendar-cancellation-http.js";

const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const booking = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const location = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const root = "/v1/organizations/" + tenant + "/owner-calendar";
const cancel = root + "/" + booking + "/cancel?locationId=" + location;

test("staging owner cancellation has no default and rejects invalid cutoff", () => {
  assert.equal(parseStagingOwnerCancellationCutoff(undefined), undefined);
  for (const raw of ["0", "1", "525600"])
    assert.equal(parseStagingOwnerCancellationCutoff(raw), Number(raw));
  for (const raw of [
    "",
    "-1",
    "00",
    "01",
    "1.5",
    "525601",
    "foo",
    "0 ",
    "999999999",
  ])
    assert.throws(() => parseStagingOwnerCancellationCutoff(raw));
});

test("owner write routes are opt-in and validate before database access", async () => {
  let databaseCalls = 0;
  const pool = {
    query() {
      databaseCalls++;
      throw new Error("test-only DB denied");
    },
    connect() {
      databaseCalls++;
      throw new Error("test-only DB denied");
    },
  } as unknown as Pool;
  const verifier = {
    async verifyBearerToken(token: string) {
      return token === "unit-test-token"
        ? {
            tenantId: tenant,
            identityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 120,
          }
        : null;
    },
  };
  const disabled = createApp(pool);
  const app = createApp(pool, {
    stagingOwnerCalendarCancellation: {
      pool,
      verifier,
      enabled: true,
      cutoffMinutes: 0,
    },
  });
  const authorization = { authorization: "Bearer unit-test-token" };
  try {
    assert.equal(
      (
        await disabled.inject({
          method: "GET",
          url: root + "/cancellation/capability",
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await disabled.inject({
          method: "POST",
          url: cancel,
          payload: {},
        })
      ).statusCode,
      404,
    );
    const noAuth = await app.inject({
      method: "GET",
      url: root + "/cancellation/capability",
    });
    assert.equal(noAuth.statusCode, 401);
    assert.equal(noAuth.headers["cache-control"], "no-store");
    assert.equal(noAuth.headers.vary, "Authorization");
    assert.equal(
      (await app.inject({ method: "POST", url: cancel, payload: {} }))
        .statusCode,
      401,
    );
    for (const url of [
      cancel + "&unexpected=1",
      cancel.replace("locationId=" + location, "locationId=bad"),
      root + "/invalid/cancel?locationId=" + location,
    ]) {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            headers: {
              ...authorization,
              "idempotency-key": "unit-test-valid-key-01",
            },
            payload: {},
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: cancel,
          headers: authorization,
          payload: {},
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: cancel,
          headers: {
            ...authorization,
            "idempotency-key": "unit-test-valid-key-01",
          },
          payload: { customerId: location },
        })
      ).statusCode,
      400,
    );
    assert.equal(databaseCalls, 0);
  } finally {
    await app.close();
    await disabled.close();
  }
});
