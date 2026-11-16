import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localDay,
  mondayOf,
  offsetDay,
  parseDay,
  upcomingWeekday,
} from "./dates";

test("calendar week starts on Monday, including year boundary", () => {
  assert.equal(mondayOf("2026-11-15"), "2026-11-09");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
  assert.equal(mondayOf("2026-11-16"), "2026-11-16");
});

test("day navigation handles month and year changes without UTC drift", () => {
  assert.equal(offsetDay("2026-12-31", 1), "2027-01-01");
  assert.equal(offsetDay("2027-01-01", -1), "2026-12-31");
  assert.equal(localDay(parseDay("2026-11-16")), "2026-11-16");
});

test("upcoming demo weekday respects selected days", () => {
  assert.equal(upcomingWeekday("2026-11-15", [1, 3]), "2026-11-16");
  assert.equal(upcomingWeekday("2026-11-16", [3]), "2026-11-18");
  assert.equal(upcomingWeekday("2026-11-16", []), "2026-11-16");
});
