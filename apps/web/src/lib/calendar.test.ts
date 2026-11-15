import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingsForDay } from "./calendar";
import type { BookingView } from "./model";

const base: BookingView = {
  id: "b",
  organizationId: "org",
  locationId: "loc",
  serviceId: "service",
  staffId: "staff",
  date: "2026-11-16",
  time: "15:00",
  clientAlias: "Synthetic guest",
  status: "demo-confirmed",
};

test("calendar selects date and sorts identical slot times deterministically", () => {
  const input: BookingView[] = [
    base,
    { ...base, id: "c", time: "09:00" },
    { ...base, id: "a", time: "09:00" },
    { ...base, id: "hidden", date: "2026-11-17" },
  ];
  assert.deepEqual(
    bookingsForDay(input, "2026-11-16").map((item) => item.id),
    ["a", "c", "b"],
  );
  assert.equal(input[0]?.id, "b", "input must not be mutated");
  assert.deepEqual(bookingsForDay(input, "2026-12-01"), []);
});
