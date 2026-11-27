import assert from "node:assert/strict";
import test from "node:test";

import type { OwnerCalendarEntry } from "./owner-calendar-api";
import { summarizeOwnerDay } from "./owner-overview-day";

const entry: OwnerCalendarEntry = {
  id: "a",
  staffId: "staff-a",
  staffName: "Synthetic staff",
  serviceName: "Synthetic service",
  status: "Confirmed",
  startAt: "2026-11-28T10:00:00.000Z",
  endAt: "2026-11-28T11:00:00.000Z",
  priceKopecks: "125050",
};

test("summary uses persisted price and stable staff IDs, not labels", () => {
  assert.deepEqual(
    summarizeOwnerDay([
      entry,
      { ...entry, id: "b", priceKopecks: "100" },
      { ...entry, id: "c", staffId: "staff-b" },
      { ...entry, id: "d", status: "CancelledByClient" },
      { ...entry, id: "e", status: "Completed" },
    ]),
    { entries: 5, confirmedPriceKopecks: 250200, confirmedStaff: 2 },
  );
});

test("verified empty data yields zero, missing staff ID yields unknown", () => {
  assert.deepEqual(summarizeOwnerDay([]), {
    entries: 0,
    confirmedPriceKopecks: 0,
    confirmedStaff: 0,
  });
  const { staffId, ...legacy } = entry;
  assert.equal(staffId, "staff-a");
  assert.equal(summarizeOwnerDay([legacy]).confirmedStaff, null);
  assert.equal(
    summarizeOwnerDay([{ ...legacy, status: "CancelledByBusiness" }])
      .confirmedStaff,
    0,
  );
});
