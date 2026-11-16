import assert from "node:assert/strict";
import { test } from "node:test";
import { weekdays } from "./weekdays";

test("weekday order uses Sunday=0", () => {
  const numbers = weekdays.map((day) => day.number);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(new Set(numbers).size, 7);
});
