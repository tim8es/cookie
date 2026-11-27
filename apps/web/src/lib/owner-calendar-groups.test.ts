import assert from "node:assert/strict";
import test from "node:test";

import {
  CalendarReadError,
  readOwnerCalendar,
  type OwnerCalendar,
  type OwnerCalendarEntry,
} from "./owner-calendar-api";
import { groupCalendar } from "./owner-calendar-groups";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const locationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const staffId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherStaff = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const session = {
  tenantId,
  accessToken: "synthetic-calendar-token",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 60,
};

function booking(index: number, startAt: string): OwnerCalendarEntry {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-" + String(index).padStart(12, "0"),
    staffId,
    staffName: "Synthetic staff",
    serviceName: "Synthetic service",
    status: "Confirmed",
    startAt,
    endAt: new Date(Date.parse(startAt) + 3600000).toISOString(),
    priceKopecks: "100000",
  };
}

const base: OwnerCalendar = {
  locationId,
  localDate: "2027-03-14",
  days: 1,
  timeZone: "America/New_York",
  entries: [],
};

test("day groups by stable staff ID, not display label", () => {
  const first = booking(1, "2027-03-14T12:00:00.000Z");
  const second = booking(2, "2027-03-14T13:00:00.000Z");
  const third = { ...booking(3, "2027-03-14T14:00:00.000Z"), staffId: otherStaff };
  const groups = groupCalendar({ ...base, entries: [first, second, third] });
  assert.deepEqual(
    groups.map((group) => group.entries.map((entry) => entry.id)),
    [[first.id, second.id], [third.id]],
  );
  assert.equal(groups[0]?.label, groups[1]?.label);
});

test("legacy server entries without staff ID never merge by name", () => {
  const { staffId: _first, ...first } = booking(
    1,
    "2027-03-14T12:00:00.000Z",
  );
  const { staffId: _second, ...second } = booking(
    2,
    "2027-03-14T13:00:00.000Z",
  );
  assert.equal(groupCalendar({ ...base, entries: [first, second] }).length, 2);
});

test("week groups local dates across DST and preserves carry-in once", () => {
  const carry = booking(1, "2027-03-14T04:30:00.000Z");
  const late = booking(2, "2027-03-15T03:00:00.000Z");
  const next = booking(3, "2027-03-15T04:00:00.000Z");
  const groups = groupCalendar({
    ...base,
    days: 7,
    entries: [carry, late, next],
  });
  assert.equal(groups.length, 7);
  assert.equal(groups[0]?.id, "2027-03-14");
  assert.deepEqual(groups[0]?.entries, [carry, late]);
  assert.deepEqual(groups[1]?.entries, [next]);
  assert.equal(groups.flatMap((group) => group.entries).length, 3);
  assert.equal(groups[6]?.id, "2027-03-20");
});

test("calendar parser preserves staff ID, accepts old contract, rejects invalid ID", async () => {
  const current = booking(1, "2027-03-14T12:00:00.000Z");
  const { staffId: _legacy, ...legacy } = booking(
    2,
    "2027-03-14T13:00:00.000Z",
  );
  const data = { ...base, entries: [current, legacy] };
  const read = (value: unknown) =>
    readOwnerCalendar(session, locationId, base.localDate, 1, async () =>
      Response.json(value),
    );
  assert.deepEqual(await read(data), data);
  for (const invalid of [null, "", "not-a-uuid"]) {
    await assert.rejects(
      read({ ...base, entries: [{ ...current, staffId: invalid }] }),
      (error: unknown) =>
        error instanceof CalendarReadError && error.reason === "invalid-response",
    );
  }
});
