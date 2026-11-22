import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readStagingOwnerRescheduleCutoff,
  readOwnerRescheduleSlots,
  rescheduleOwnerCalendarBooking,
} from "./staging-owner-calendar-reschedule-api";

const session = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  accessToken: "synthetic-owner-bearer",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 900,
};
const location = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const booking = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const key = "synthetic-owner-reschedule-001";
const prefix = "/v1/organizations/" + session.tenantId + "/owner-calendar";
const date = "2027-03-01";
const timeZone = "Asia/Yekaterinburg";
const time = "2027-03-01T05:00:00.000Z";
const slots = {
  localDate: date,
  timeZone,
  slots: [
    { startAt: time, endAt: "2027-03-01T06:00:00.000Z" },
    { startAt: "2027-03-01T06:30:00.000Z", endAt: "2027-03-01T07:30:00.000Z" },
  ],
};
const receipt = {
  bookingId: booking,
  status: "Confirmed",
  previousStartAt: "2027-03-01T04:00:00.000Z",
  startAt: time,
  endAt: "2027-03-01T06:00:00.000Z",
  occupiedUntil: "2027-03-01T06:15:00.000Z",
  priceKopecks: "125050",
};

test("owner move capability is explicit and rejects missing or malformed cutoff", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, prefix + "/reschedule/capability");
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + session.accessToken);
    return Response.json({ cutoffMinutes: 0 });
  };
  assert.equal(await readStagingOwnerRescheduleCutoff(session, fetcher), 0);
  for (const cutoffMinutes of [-1, "60", null, 525601, 1.5]) {
    assert.equal(await readStagingOwnerRescheduleCutoff(session, async () =>
      Response.json({ cutoffMinutes })), null);
  }
  assert.equal(await readStagingOwnerRescheduleCutoff(session, async () =>
    Response.json({}, { status: 404 })), null);
});

test("owner slots use verified tenant, branch and booking; reject malformed data", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, prefix + "/" + booking + "/reschedule/slots?locationId=" +
      location + "&localDate=" + date);
    assert.equal(init?.method, "GET");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + session.accessToken);
    return Response.json(slots);
  };
  assert.deepEqual(await readOwnerRescheduleSlots(
    session, location, booking, date, timeZone, fetcher,
  ), slots);
  for (const result of [
    { ...slots, timeZone: "UTC" },
    { ...slots, localDate: "2027-03-02" },
    { ...slots, slots: [{ ...slots.slots[0], startAt: "2027-04-01T05:00:00.000Z" }] },
    { ...slots, slots: [slots.slots[1], slots.slots[0]] },
    { ...slots, slots: [slots.slots[0], slots.slots[0]] },
  ]) {
    await assert.rejects(readOwnerRescheduleSlots(
      session, location, booking, date, timeZone,
      async () => Response.json(result),
    ), /uncertain/);
  }
  for (const [status, reason] of [[401, "denied"], [403, "denied"], [404, "conflict"], [409, "conflict"], [503, "uncertain"]] as const) {
    await assert.rejects(readOwnerRescheduleSlots(
      session, location, booking, date, timeZone,
      async () => Response.json({}, { status }),
    ), new RegExp(reason));
  }
});

test("owner move retries the exact key on lost response and requires committed receipt", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, prefix + "/" + booking + "/reschedule?locationId=" + location);
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + session.accessToken);
    assert.equal(new Headers(init?.headers).get("idempotency-key"), key);
    assert.deepEqual(JSON.parse(String(init?.body)), { newStartAt: time });
    if (calls === 1) throw new Error("lost synthetic response");
    return Response.json(receipt);
  };
  await assert.rejects(rescheduleOwnerCalendarBooking(
    session, location, booking, time, key, fetcher,
  ), /uncertain/);
  assert.deepEqual(await rescheduleOwnerCalendarBooking(
    session, location, booking, time, key, fetcher,
  ), receipt);
  assert.equal(calls, 2);
});

test("owner move refuses forged receipts, noncommits, invalid inputs and expired bearer", async () => {
  for (const bad of [
    { ...receipt, bookingId: location },
    { ...receipt, status: "Pending" },
    { ...receipt, startAt: "2027-03-01T06:00:00.000Z" },
    { ...receipt, priceKopecks: "-1" },
    { ...receipt, endAt: "2027-03-01T04:00:00.000Z" },
    { ...receipt, extra: true },
  ]) {
    await assert.rejects(rescheduleOwnerCalendarBooking(
      session, location, booking, time, key,
      async () => Response.json(bad),
    ), /uncertain/);
  }
  for (const [status, reason] of [[401, "denied"], [403, "denied"], [404, "conflict"], [409, "conflict"], [503, "uncertain"]] as const) {
    await assert.rejects(rescheduleOwnerCalendarBooking(
      session, location, booking, time, key,
      async () => Response.json({}, { status }),
    ), new RegExp(reason));
  }
  let called = false;
  const noFetch: typeof fetch = async () => {
    called = true;
    return Response.json(receipt);
  };
  await assert.rejects(rescheduleOwnerCalendarBooking(
    session, "invalid", booking, time, key, noFetch,
  ), /uncertain/);
  await assert.rejects(rescheduleOwnerCalendarBooking(
    session, location, booking, time, "short", noFetch,
  ), /uncertain/);
  await assert.rejects(rescheduleOwnerCalendarBooking(
    { ...session, expiresAtUnixSeconds: 0 },
    location, booking, time, key, noFetch,
  ), /denied/);
  assert.equal(called, false);
});
