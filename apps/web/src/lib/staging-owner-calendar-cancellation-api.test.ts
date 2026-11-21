import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelOwnerCalendarBooking,
  readStagingOwnerCancellationCutoff,
} from "./staging-owner-calendar-cancellation-api";

const session = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  accessToken: "synthetic-owner-bearer",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 900,
};
const locationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bookingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const key = "synthetic-owner-cancel-001";
const prefix = "/v1/organizations/" + session.tenantId + "/owner-calendar";
const receipt = {
  bookingId, status: "CancelledByBusiness",
  cancelledAt: "2027-01-01T12:00:00.000Z",
};

test("owner cancellation capability is an explicit scoped opt-in", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, prefix + "/cancellation/capability");
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + session.accessToken);
    return Response.json({ cutoffMinutes: 0 });
  };
  assert.equal(await readStagingOwnerCancellationCutoff(session, fetcher), 0);
  for (const input of [undefined, -1, 1.1, "60", 525601, null]) {
    const value = input === undefined ? {} : { cutoffMinutes: input };
    assert.equal(await readStagingOwnerCancellationCutoff(
      session, async () => Response.json(value),
    ), null);
  }
  assert.equal(await readStagingOwnerCancellationCutoff(
    session, async () => Response.json({}, { status: 404 }),
  ), null);
});

test("owner cancellation repeats the same key and validates committed receipt", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, prefix + "/" + bookingId + "/cancel?locationId=" + locationId);
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.deepEqual(JSON.parse(String(init?.body)), {});
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + session.accessToken);
    assert.equal(new Headers(init?.headers).get("idempotency-key"), key);
    if (calls === 1) throw new Error("lost committed response");
    return Response.json(receipt);
  };
  await assert.rejects(cancelOwnerCalendarBooking(session, locationId, bookingId, key, fetcher), /uncertain/);
  assert.deepEqual(await cancelOwnerCalendarBooking(session, locationId, bookingId, key, fetcher), receipt);
  assert.equal(calls, 2);
});

test("owner cancellation never claims success for malformed or denied responses", async () => {
  for (const bad of [
    { ...receipt, bookingId: locationId },
    { ...receipt, status: "Confirmed" },
    { ...receipt, cancelledAt: "2027-02-30T10:00:00.000Z" },
    { ...receipt, extra: true },
  ]) {
    await assert.rejects(cancelOwnerCalendarBooking(
      session, locationId, bookingId, key,
      async () => Response.json(bad),
    ), /uncertain/);
  }
  for (const [status, reason] of [[401, "denied"], [403, "denied"], [404, "conflict"], [409, "conflict"], [503, "uncertain"]] as const) {
    await assert.rejects(cancelOwnerCalendarBooking(
      session, locationId, bookingId, key,
      async () => Response.json({}, { status }),
    ), new RegExp(reason));
  }
  let called = false;
  const noFetch: typeof fetch = async () => { called = true; return Response.json(receipt); };
  await assert.rejects(cancelOwnerCalendarBooking(session, "invalid", bookingId, key, noFetch), /uncertain/);
  await assert.rejects(cancelOwnerCalendarBooking(session, locationId, bookingId, "short", noFetch), /uncertain/);
  await assert.rejects(cancelOwnerCalendarBooking(
    { ...session, expiresAtUnixSeconds: 0 }, locationId, bookingId, key, noFetch,
  ), /denied/);
  assert.equal(called, false);
});
