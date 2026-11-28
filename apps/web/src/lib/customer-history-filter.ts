import type { OwnBooking } from "./staging-customer-history-api";

export type HistoryFilter = "all" | "confirmed" | "cancelled";

/** Filter only the verified, bounded server snapshot; never infer a status. */
export function filterOwnBookings(
  bookings: readonly OwnBooking[],
  filter: HistoryFilter,
): readonly OwnBooking[] {
  if (filter === "all") return bookings;
  if (filter === "confirmed")
    return bookings.filter((booking) => booking.status === "Confirmed");
  return bookings.filter(
    (booking) =>
      booking.status === "CancelledByClient" ||
      booking.status === "CancelledByBusiness",
  );
}
