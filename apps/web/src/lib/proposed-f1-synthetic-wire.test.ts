import assert from "node:assert/strict";
import { test } from "node:test";
import { BookingAttempt } from "./booking-attempt";
import type { ConfirmedBookingReceiptView } from "./booking-attempt-view";
import {
  classifyProposedF1Conflict,
  formatProposedKopecks,
  parseProposedF1Availability,
  parseProposedF1ConfirmedReceipt,
  proposedF1ReceiptView,
  type ProposedF1AvailableSlot,
} from "./proposed-f1-synthetic-wire";
import { TransportFailure } from "./transport";

// Exactly the proposed F1 synthetic BookingReceipt and Slot shape, NOT F2.
const confirmed = {
  bookingId: "10000000-1000-4000-8000-100000000001",
  status: "Confirmed",
  startAt: "2027-04-12T10:00:00.000Z",
  endAt: "2027-04-12T11:00:00.000Z",
  occupiedUntil: "2027-04-12T11:15:00.000Z",
  priceKopecks: "123456",
};
const slot = {
  startAt: "2027-04-12T10:00:00.000Z",
  endAt: "2027-04-12T11:00:00.000Z",
  occupiedUntil: "2027-04-12T11:15:00.000Z",
};

test("only exact Confirmed receipts from proposed F1 shape pass", () => {
  assert.deepEqual(parseProposedF1ConfirmedReceipt(confirmed), confirmed);
  assert.deepEqual(proposedF1ReceiptView(confirmed), {
    bookingId: confirmed.bookingId,
    dateTimeText: "12.04.2027, 10:00 UTC",
    finalPriceText: "1 234,56 ₽",
  });

  const malformed: unknown[] = [
    undefined,
    null,
    [],
    "",
    { ...confirmed, status: "Pending" },
    { ...confirmed, status: "CancelledByBusiness" },
    { ...confirmed, bookingId: "untrusted-id" },
    { ...confirmed, bookingId: 17 },
    { ...confirmed, priceKopecks: 123456 },
    { ...confirmed, priceKopecks: "12.5" },
    { ...confirmed, priceKopecks: "-1" },
    { ...confirmed, priceKopecks: "123 RUB" },
    { ...confirmed, customerId: "server did not return this field" },
    { ...confirmed, endAt: confirmed.startAt },
    { ...confirmed, occupiedUntil: "2027-04-12T10:10:00Z" },
    { ...confirmed, startAt: "2027-02-30T10:00:00.000Z" },
    { ...confirmed, startAt: "2027-04-12T10:00:00+03:00" },
    { ...confirmed, startAt: "2027-04-12T10:00:00" },
  ];
  for (const value of malformed) {
    assert.equal(parseProposedF1ConfirmedReceipt(value), null, JSON.stringify(value));
    assert.equal(proposedF1ReceiptView(value), null);
  }
});

test("UTC millisecond precision is ordered by instant, not lexical strings", () => {
  // A later fractional instant sorts before 'Z' lexically.
  const withMillis = {
    ...confirmed,
    startAt: "2027-04-12T10:00:00Z",
    endAt: "2027-04-12T10:00:00.001Z",
    occupiedUntil: "2027-04-12T10:00:00.002Z",
  };
  assert.ok(parseProposedF1ConfirmedReceipt(withMillis));
});

test("availability never supplies a confirmed receipt or fabricated price", () => {
  assert.deepEqual(
    parseProposedF1Availability({ priceKopecks: "50000", slots: [slot] }),
    { priceKopecks: "50000", slots: [slot] },
  );
  assert.deepEqual(
    parseProposedF1Availability({ priceKopecks: null, slots: [] }),
    { priceKopecks: null, slots: [] },
  );
  for (const body of [
    { slots: [slot] },
    { priceKopecks: "50000", slots: [slot], confirmed: true },
    { priceKopecks: null, slots: [slot] },
    { priceKopecks: 50000, slots: [slot] },
    { priceKopecks: "50000", slots: "10:00" },
    { priceKopecks: "50000", slots: [{ ...slot, extra: true }] },
    { priceKopecks: "50000", slots: [{ ...slot, startAt: slot.endAt }] },
    { priceKopecks: "50000", slots: [{ ...slot, startAt: "wrong" }] },
    { priceKopecks: "50000", slots: [{ ...slot, occupiedUntil: slot.startAt }] },
  ]) {
    assert.equal(parseProposedF1Availability(body), null);
  }
  // Availability is only a provisional base price; confirmation uses the
  // new server receipt even when the catalog changed between calls.
  assert.equal(proposedF1ReceiptView({ ...confirmed, priceKopecks: "55000" })?.finalPriceText, "550 ₽");
});

test("kopeck display has exact decimal precision and never uses float roubles", () => {
  assert.equal(formatProposedKopecks("0"), "0 ₽");
  assert.equal(formatProposedKopecks("1"), "0,01 ₽");
  assert.equal(formatProposedKopecks("50"), "0,50 ₽");
  assert.equal(formatProposedKopecks("100"), "1 ₽");
  assert.equal(formatProposedKopecks("1000"), "10 ₽");
  assert.equal(formatProposedKopecks("000123456"), "1 234,56 ₽");
  assert.equal(formatProposedKopecks("900719925474099312345"), "9 007 199 254 740 993 123,45 ₽");
  assert.equal(formatProposedKopecks("NaN"), null);
  assert.equal(formatProposedKopecks("-1"), null);
});

test("409 is classified only from exact proposed error DTO", () => {
  const err = (code: unknown): TransportFailure =>
    new TransportFailure("conflict", 409, { error: { code } });
  assert.equal(classifyProposedF1Conflict(err("BOOKING_CONFLICT")), "slot-unavailable");
  assert.equal(classifyProposedF1Conflict(err("IDEMPOTENCY_KEY_REUSED")), "idempotency-key-reused");
  assert.equal(classifyProposedF1Conflict(err("OTHER")), "unknown");
  assert.equal(classifyProposedF1Conflict(new TransportFailure("conflict", 409)), "unknown");
  assert.equal(classifyProposedF1Conflict(new TransportFailure("conflict", 409, "<html>")), "unknown");
  assert.equal(classifyProposedF1Conflict(new TransportFailure("conflict", 409, { code: "BOOKING_CONFLICT" })), "unknown");
  assert.equal(classifyProposedF1Conflict(new TransportFailure("conflict", 409, { error: { code: "BOOKING_CONFLICT", message: "spoof" } })), "unknown");
  assert.equal(classifyProposedF1Conflict(new TransportFailure("http", 409, { error: { code: "BOOKING_CONFLICT" } })), "unknown");
  assert.equal(classifyProposedF1Conflict(new TransportFailure("conflict", 403, { error: { code: "BOOKING_CONFLICT" } })), "unknown");
});

test("offline CreateBooking attempt: unknown outcome retries same key and accepts only validated receipt", async () => {
  const keys: string[] = [];
  const selections: string[] = [];
  let call = 0;
  const attempt = new BookingAttempt<string, ConfirmedBookingReceiptView, ProposedF1AvailableSlot>(
    {
      async create(selection, key) {
        keys.push(key);
        selections.push(selection);
        call++;
        if (call === 1) throw new TransportFailure("network");
        return confirmed;
      },
      verifyConfirmed: proposedF1ReceiptView,
      classifyConflict: classifyProposedF1Conflict,
      async refreshSlots() { return [slot]; },
    },
    () => "synthetic-attempt-key",
  );
  const first = await attempt.submit("service-A");
  assert.equal(first.phase, "error");
  assert.equal(attempt.reset(), false, "possible commit must block fresh-key reset");
  const second = await attempt.retry();
  assert.equal(second.phase, "confirmed");
  assert.deepEqual(keys, ["synthetic-attempt-key", "synthetic-attempt-key"]);
  assert.deepEqual(selections, ["service-A", "service-A"]);
  assert.equal(second.phase === "confirmed" ? second.receipt.finalPriceText : "", "1 234,56 ₽");
});

test("offline CreateBooking attempt: unverified 409 cannot appear as refreshed availability", async () => {
  const attempt = new BookingAttempt<string, ConfirmedBookingReceiptView, ProposedF1AvailableSlot>(
    {
      async create() { throw new TransportFailure("conflict", 409, { error: { code: "IDEMPOTENCY_KEY_REUSED" } }); },
      verifyConfirmed: proposedF1ReceiptView,
      classifyConflict: classifyProposedF1Conflict,
      async refreshSlots() { throw new Error("Must not fetch slots for reused key"); },
    },
    () => "synthetic-key",
  );
  const state = await attempt.submit("service-A");
  assert.deepEqual(state, { phase: "error", reason: "idempotency-key-reused", retryable: false });
  assert.equal(attempt.reset(), false);
  assert.deepEqual(await attempt.retry(), state);
});
