import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingFeedback, type ClientBookingState } from "./booking-attempt-view";

test("only a validated Confirmed phase can show success copy", () => {
  const cases: ClientBookingState[] = [
    { phase: "idle" },
    { phase: "submitting" },
    { phase: "conflict", slots: [], refreshFailed: false },
    { phase: "denied", reason: "forbidden" },
    { phase: "error", reason: "network", retryable: true },
    { phase: "error", reason: "unverified-conflict", retryable: false },
    { phase: "error", reason: "idempotency-key-reused", retryable: false },
  ];

  for (const state of cases) {
    assert.notEqual(bookingFeedback(state)?.title, "Запись подтверждена");
  }

  const confirmed: ClientBookingState = {
    phase: "confirmed",
    receipt: {
      bookingId: "synthetic-id",
      dateTimeText: "Test day 10:00",
      finalPriceText: "1250 ₽",
    },
  };
  assert.equal(bookingFeedback(confirmed)?.title, "Запись подтверждена");
});

test("an uncertain result allows only same-attempt retry, never a new booking", () => {
  const unknown: ClientBookingState = {
    phase: "error",
    reason: "unverified-conflict",
    retryable: false,
  };
  const network: ClientBookingState = {
    phase: "error",
    reason: "network",
    retryable: true,
  };
  assert.equal(bookingFeedback(unknown)?.canRetry, false);
  assert.match(bookingFeedback(unknown)?.description ?? "", /Не создавайте новую/);
  assert.equal(bookingFeedback(network)?.canRetry, true);
  assert.match(bookingFeedback(network)?.description ?? "", /ту же попытку/);
});

test("failed refresh cannot suggest availability that was not returned", () => {
  const state: ClientBookingState = {
    phase: "conflict",
    slots: [],
    refreshFailed: true,
  };
  assert.equal(bookingFeedback(state)?.announce, "alert");
  assert.match(bookingFeedback(state)?.description ?? "", /Не удалось обновить/);
});
