import assert from "node:assert/strict";
import { test } from "node:test";
import { weekdays } from "./weekdays";

test("weekday picker matches the browser's Sunday=0 date convention", () => {
  assert.deepEqual(weekdays.map((day) => day.number), [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(new Set(weekdays.map((day) => day.number)).size, 7);
});
