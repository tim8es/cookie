import assert from "node:assert/strict";
import { test } from "node:test";
import { receiptDisposition } from "./customer-receipt-disposition";
import type { ConfirmedBookingReceipt } from "./confirmed-booking-receipt";
import type { OwnBooking } from "./staging-customer-history-api";

const receipt: ConfirmedBookingReceipt = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  status: "Confirmed",
  startAt: "2028-12-14T10:00:00.000Z",
  endAt: "2028-12-14T11:00:00.000Z",
  occupiedUntil: "2028-12-14T11:15:00.000Z",
  priceKopecks: "125050",
};
const row: OwnBooking = {
  bookingId: receipt.bookingId,
  status: receipt.status,
  startAt: receipt.startAt,
  endAt: receipt.endAt,
  priceKopecks: receipt.priceKopecks,
  locationName: "Branch",
  staffName: "Staff",
  serviceName: "Service",
  timeZone: "Europe/Moscow",
};

test("only exact unchanged history row matches receipt", () => {
  assert.equal(
    receiptDisposition(receipt, { bookings: [row], hasMore: false }),
    "original",
  );
  assert.equal(receiptDisposition(receipt, null), "unverified");
  assert.equal(
    receiptDisposition(receipt, { bookings: [], hasMore: true }),
    "unverified",
  );
  const other = { ...row, bookingId: "foreign" };
  assert.equal(
    receiptDisposition(receipt, { bookings: [other], hasMore: false }),
    "unverified",
  );
});

test("cancellation or new time invalidates original state", () => {
  const changes: OwnBooking[] = [
    { ...row, status: "CancelledByClient" },
    { ...row, status: "CancelledByBusiness" },
    { ...row, status: "Completed" },
    { ...row, status: "NoShow" },
    { ...row, startAt: "2028-12-14T12:00:00.000Z" },
    { ...row, endAt: "2028-12-14T12:00:00.000Z" },
    { ...row, priceKopecks: "120000" },
  ];
  for (const changed of changes) {
    assert.equal(
      receiptDisposition(receipt, { bookings: [changed], hasMore: false }),
      "changed",
    );
  }
});
