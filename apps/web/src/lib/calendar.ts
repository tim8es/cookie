import type { BookingView } from "./model";

/** Presentation ordering only; not an availability or conflict check. */
export function bookingsForDay(bookings: readonly BookingView[], date: string): BookingView[] {
  return bookings
    .filter((booking) => booking.date === date)
    .sort((left, right) =>
      left.time.localeCompare(right.time) || left.id.localeCompare(right.id),
    );
}
