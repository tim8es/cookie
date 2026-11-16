import type { BookingView } from "./model";

/** Presentation ordering only; not an availability or conflict check. */
export function bookingsForDay(
  bookings: readonly BookingView[],
  date: string,
): BookingView[] {
  return bookings
    .filter((booking) => booking.date === date)
    .sort((left, right) => {
      const timeComparison = left.time.localeCompare(right.time);
      return timeComparison || left.id.localeCompare(right.id);
    });
}
