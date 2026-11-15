import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAvailableStart,
  listAvailableSlots,
  type AvailabilityRequest,
} from "../src/index.js";

const at = (hour: string): string => `2026-11-15T${hour}:00Z`;
const empty: AvailabilityRequest = {
  organizationId: "org-a",
  staffId: "staff-1",
  locationId: "loc-a",
  localDate: "2026-11-15",
  timeZone: "UTC",
  serviceDurationMinutes: 60,
  postServiceBufferMinutes: 10,
  stepMinutes: 5,
  shifts: [{ startAt: at("10:00"), endAt: at("13:00") }],
  breaks: [],
  exceptions: [],
  occupied: [],
};

test("F1 slots include service duration and post-service occupancy separately", () => {
  const slots = listAvailableSlots(empty);
  assert.equal(slots[0]?.startAt, at("10:00").replace(":00Z", ":00.000Z"));
  assert.equal(slots[0]?.endAt, at("11:00").replace(":00Z", ":00.000Z"));
  assert.equal(
    slots[0]?.occupiedUntil,
    at("11:10").replace(":00Z", ":00.000Z"),
  );
  assert.equal(slots.at(-1)?.startAt, "2026-11-15T11:50:00.000Z");
  assert.equal(slots.length, 23);
});

test("global staff occupancy blocks a second location even when client visit ended", () => {
  const request: AvailabilityRequest = {
    ...empty,
    locationId: "loc-b",
    occupied: [
      {
        organizationId: "org-a",
        staffId: "staff-1",
        locationId: "loc-a",
        startAt: at("10:00"),
        occupiedUntil: at("11:10"),
      },
    ],
  };
  assert.equal(evaluateAvailableStart(request, at("11:05")), null);
  assert.equal(
    evaluateAvailableStart(request, at("11:10"))?.startAt,
    "2026-11-15T11:10:00.000Z",
  );
});

test("same-time non-overlapping booking is allowed at occupiedUntil boundary", () => {
  const request: AvailabilityRequest = {
    ...empty,
    occupied: [
      {
        organizationId: "org-a",
        staffId: "staff-1",
        locationId: "loc-b",
        startAt: at("09:00"),
        occupiedUntil: at("10:00"),
      },
    ],
  };
  assert.ok(evaluateAvailableStart(request, at("10:00")));
});

test("breaks and exceptions forbid any service or buffer overlap", () => {
  const request: AvailabilityRequest = {
    ...empty,
    breaks: [{ startAt: at("11:00"), endAt: at("11:15") }],
    exceptions: [{ startAt: at("12:00"), endAt: at("12:30") }],
  };
  assert.equal(evaluateAvailableStart(request, at("10:00")), null);
  assert.equal(evaluateAvailableStart(request, at("11:15")), null);
  assert.ok(evaluateAvailableStart(request, at("11:20")) === null);
  assert.ok(evaluateAvailableStart(request, at("12:30")) === null);
  const shorter = {
    ...request,
    serviceDurationMinutes: 15,
    postServiceBufferMinutes: 0,
  };
  assert.ok(evaluateAvailableStart(shorter, at("11:15")));
  assert.equal(evaluateAvailableStart(shorter, at("11:50")), null);
});

test("shift end must accommodate buffer, not just the visible visit", () => {
  const request = {
    ...empty,
    shifts: [{ startAt: at("10:00"), endAt: at("11:00") }],
  };
  assert.equal(listAvailableSlots(request).length, 0);
  assert.ok(
    evaluateAvailableStart(
      { ...request, postServiceBufferMinutes: 0 },
      at("10:00"),
    ),
  );
});

test("slot grid is anchored to each shift; arbitrary starts are rejected", () => {
  assert.equal(evaluateAvailableStart(empty, at("10:01")), null);
  assert.ok(evaluateAvailableStart(empty, at("10:05")));
});

test("overlapping shifts are returned as sorted unique slots", () => {
  const request = {
    ...empty,
    shifts: [
      { startAt: at("10:00"), endAt: at("12:00") },
      { startAt: at("10:00"), endAt: at("13:00") },
    ],
  };
  const starts = listAvailableSlots(request).map((slot) => slot.startAt);
  assert.equal(new Set(starts).size, starts.length);
  assert.equal(starts.length, 23);
  assert.equal(starts[0], "2026-11-15T10:00:00.000Z");
});

test("the requested local calendar day filters shifts that cross midnight", () => {
  const request: AvailabilityRequest = {
    ...empty,
    timeZone: "Europe/Helsinki",
    localDate: "2026-11-16",
    serviceDurationMinutes: 30,
    postServiceBufferMinutes: 0,
    stepMinutes: 30,
    shifts: [
      { startAt: "2026-11-15T21:30:00Z", endAt: "2026-11-16T00:30:00Z" },
    ],
  };
  assert.deepEqual(
    listAvailableSlots(request).map((slot) => slot.startAt),
    [
      "2026-11-15T22:00:00.000Z",
      "2026-11-15T22:30:00.000Z",
      "2026-11-15T23:00:00.000Z",
      "2026-11-15T23:30:00.000Z",
      "2026-11-16T00:00:00.000Z",
    ],
  );
});

test("spring-forward DST never synthesizes nonexistent local hours", () => {
  const request: AvailabilityRequest = {
    ...empty,
    localDate: "2026-03-08",
    timeZone: "America/New_York",
    serviceDurationMinutes: 30,
    postServiceBufferMinutes: 0,
    stepMinutes: 30,
    shifts: [
      { startAt: "2026-03-08T06:00:00Z", endAt: "2026-03-08T08:00:00Z" },
    ],
  };
  assert.deepEqual(
    listAvailableSlots(request).map((slot) => slot.startAt),
    [
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:30:00.000Z",
    ],
  );
});

test("fall-back DST retains distinct UTC instants for repeated local hour", () => {
  const request: AvailabilityRequest = {
    ...empty,
    localDate: "2026-11-01",
    timeZone: "America/New_York",
    serviceDurationMinutes: 30,
    postServiceBufferMinutes: 0,
    stepMinutes: 30,
    shifts: [
      { startAt: "2026-11-01T05:00:00Z", endAt: "2026-11-01T07:00:00Z" },
    ],
  };
  assert.deepEqual(
    listAvailableSlots(request).map((slot) => slot.startAt),
    [
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ],
  );
});

test("unexpected tenant or staff busy intervals fail closed", () => {
  const occupancy = {
    organizationId: "other-org",
    staffId: "staff-1",
    locationId: "loc-b",
    startAt: at("10:00"),
    occupiedUntil: at("11:00"),
  };
  assert.throws(
    () => listAvailableSlots({ ...empty, occupied: [occupancy] }),
    RangeError,
  );
  assert.throws(
    () =>
      listAvailableSlots({
        ...empty,
        occupied: [
          { ...occupancy, organizationId: "org-a", staffId: "other-staff" },
        ],
      }),
    RangeError,
  );
});

test("malformed dates, timezone, ranges and duration are rejected", () => {
  assert.throws(
    () => listAvailableSlots({ ...empty, timeZone: "Invalid/TimeZone" }),
    RangeError,
  );
  assert.throws(
    () => listAvailableSlots({ ...empty, localDate: "2026-02-30" }),
    RangeError,
  );
  assert.throws(
    () => listAvailableSlots({ ...empty, serviceDurationMinutes: 0 }),
    RangeError,
  );
  assert.throws(
    () => listAvailableSlots({ ...empty, postServiceBufferMinutes: -1 }),
    RangeError,
  );
  assert.throws(
    () => listAvailableSlots({ ...empty, stepMinutes: 0 }),
    RangeError,
  );
  assert.throws(
    () =>
      listAvailableSlots({
        ...empty,
        breaks: [{ startAt: at("12:00"), endAt: at("11:00") }],
      }),
    RangeError,
  );
  assert.throws(
    () => evaluateAvailableStart(empty, "2026-11-15T10:00:00+00:00"),
    RangeError,
  );
});

test("empty working hours return no slots, not invented availability", () => {
  assert.deepEqual(listAvailableSlots({ ...empty, shifts: [] }), []);
});
