import type { ConfirmedBookingReceipt } from "./confirmed-booking-receipt.js";
import type { OwnBookingHistory } from "./staging-customer-history-api.js";

export type ReceiptDisposition = "original" | "changed" | "unverified";

/** A Create receipt proves the original operation, not current Booking state.
 * Only a validated history row for that exact ID can establish a match.
 * Missing records (including truncated history) are not proof of cancellation.
 */
export function receiptDisposition(
  receipt: ConfirmedBookingReceipt,
  history: OwnBookingHistory | null,
): ReceiptDisposition {
  const row = history?.bookings.find(
    (booking) => booking.bookingId === receipt.bookingId,
  );
  if (!row) return "unverified";
  if (
    row.status !== "Confirmed" ||
    row.startAt !== receipt.startAt ||
    row.endAt !== receipt.endAt ||
    row.priceKopecks !== receipt.priceKopecks
  ) {
    return "changed";
  }
  return "original";
}
