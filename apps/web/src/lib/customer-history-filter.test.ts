import assert from "node:assert/strict";
import test from "node:test";

import { filterOwnBookings } from "./customer-history-filter";
import type {
  CustomerBookingStatus,
  OwnBooking,
} from "./staging-customer-history-api";

const statuses: CustomerBookingStatus[] = [
  "Confirmed",
  "CancelledByClient",
  "Completed",
  "CancelledByBusiness",
  "NoShow",
];
const rows: OwnBooking[] = statuses.map((status, index) => ({
  bookingId: String(index),
  status,
  startAt: "2026-01-01T10:00:00.000Z",
  endAt: "2026-01-01T11:00:00.000Z",
  priceKopecks: "10000",
  serviceName: "Synthetic service",
  staffName: "Synthetic staff",
  locationName: "Synthetic branch",
  timeZone: "UTC",
}));

test("history filters use server statuses and preserve order", () => {
  assert.equal(filterOwnBookings(rows, "all"), rows);
  assert.deepEqual(filterOwnBookings(rows, "confirmed"), [rows[0]]);
  assert.deepEqual(filterOwnBookings(rows, "cancelled"), [rows[1], rows[3]]);
  const actualStatuses = rows.map((row) => row.status);
  assert.deepEqual(actualStatuses, statuses);
});

test("empty and filtered-empty history never invents records", () => {
  assert.deepEqual(filterOwnBookings([], "all"), []);
  assert.deepEqual(filterOwnBookings([], "confirmed"), []);
  assert.deepEqual(filterOwnBookings([rows[0]!], "cancelled"), []);
});
