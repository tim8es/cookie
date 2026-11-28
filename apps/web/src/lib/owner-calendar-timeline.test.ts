import assert from "node:assert/strict";
import test from "node:test";

import type { OwnerCalendar, OwnerCalendarEntry } from "./owner-calendar-api";
import { buildDayTimeline } from "./owner-calendar-timeline";

const base: OwnerCalendar = {
  locationId: "branch",
  localDate: "2027-03-14",
  days: 1,
  timeZone: "America/New_York",
  rangeStartAt: "2027-03-14T05:00:00.000Z",
  rangeEndAt: "2027-03-15T04:00:00.000Z",
  entries: [],
};

function entry(id: string, startAt: string, endAt: string): OwnerCalendarEntry {
  return {
    id,
    staffId: "staff",
    staffName: "Synthetic staff",
    serviceName: "Synthetic service",
    status: "Confirmed",
    priceKopecks: "100",
    startAt,
    endAt,
  };
}

test("spring transition uses actual 23-hour elapsed range", () => {
  const result = buildDayTimeline(base);
  assert.equal(result?.duration, 23 * 60);
  assert.equal(result?.ticks.length, 23);
  assert.ok(result?.ticks.every((tick) => !tick.label.startsWith("02:00")));
});

test("autumn repeated hour has separate positions and offset labels", () => {
  const result = buildDayTimeline({
    ...base,
    localDate: "2027-11-07",
    rangeStartAt: "2027-11-07T04:00:00.000Z",
    rangeEndAt: "2027-11-08T05:00:00.000Z",
  });
  assert.equal(result?.duration, 25 * 60);
  const repeated = result?.ticks.filter((tick) =>
    tick.label.startsWith("01:00"),
  );
  assert.equal(repeated?.length, 2);
  assert.notEqual(repeated?.[0]?.label, repeated?.[1]?.label);
  assert.equal((repeated?.[1]?.top ?? 0) - (repeated?.[0]?.top ?? 0), 60);
});

test("carry-in is clipped and overlapping hit targets have separate lanes", () => {
  const first = entry(
    "first",
    "2027-03-14T04:30:00.000Z",
    "2027-03-14T05:15:00.000Z",
  );
  const second = entry(
    "second",
    "2027-03-14T05:15:00.000Z",
    "2027-03-14T05:25:00.000Z",
  );
  const result = buildDayTimeline({ ...base, entries: [first, second] });
  const column = result?.columns[0];
  assert.equal(column?.events[0]?.top, 0);
  assert.equal(column?.events[0]?.height, 15);
  assert.equal(column?.events[0]?.carryIn, true);
  assert.equal(column?.events[1]?.top, 15);
  assert.equal(column?.lanes, 2);
  assert.notEqual(column?.events[0]?.lane, column?.events[1]?.lane);
});

test("old server and week view retain list fallback", () => {
  assert.equal(buildDayTimeline({ ...base, days: 7 }), null);
  const { rangeStartAt, rangeEndAt, ...legacy } = base;
  assert.ok(rangeStartAt && rangeEndAt);
  assert.equal(buildDayTimeline(legacy), null);
});
