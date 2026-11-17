import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyBookingReceipt } from "./confirmed-booking-receipt";

const receipt = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  status: "Confirmed",
  startAt: "2028-04-12T10:00:00.000Z",
  endAt: "2028-04-12T11:00:00.000Z",
  occupiedUntil: "2028-04-12T11:10:00.000Z",
  priceKopecks: "159900",
};

test("verified receipt preserves the actual backend price and interval", () => {
  assert.deepEqual(verifyBookingReceipt(receipt, receipt.startAt), receipt);
  const free = { ...receipt, priceKopecks: "0" };
  assert.deepEqual(verifyBookingReceipt(free, free.startAt), free);
});

test("pending, malformed or mismatched receipts cannot confirm a booking", () => {
  for (const raw of [
    null,
    { ...receipt, status: "Pending" },
    { ...receipt, bookingId: "fake" },
    { ...receipt, customerId: "unrequested" },
    { ...receipt, endAt: receipt.startAt },
    { ...receipt, occupiedUntil: receipt.startAt },
    { ...receipt, endAt: "2028-02-30T11:00:00.000Z" },
    { ...receipt, priceKopecks: 159900 },
    { ...receipt, priceKopecks: "-1" },
    { ...receipt, priceKopecks: "9223372036854775808" },
    { ...receipt, priceKopecks: "0159900" },
  ]) {
    assert.equal(verifyBookingReceipt(raw, receipt.startAt), null);
  }
  assert.equal(
    verifyBookingReceipt(receipt, "2028-04-12T12:00:00.000Z"),
    null,
  );
});
