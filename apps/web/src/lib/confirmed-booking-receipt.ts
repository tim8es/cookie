/** Strict projection of the current internal CreateBooking receipt.
 * No public or staging write endpoint is enabled by this module.
 * Monetary values are preserved as exact server-supplied kopecks.
 */
export interface ConfirmedBookingReceipt {
  readonly bookingId: string;
  readonly status: "Confirmed";
  readonly startAt: string;
  readonly endAt: string;
  readonly occupiedUntil: string;
  readonly priceKopecks: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function verifyBookingReceipt(
  raw: unknown,
  requestedStartAt: string,
): ConfirmedBookingReceipt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (
    Object.keys(row).length !== 6 ||
    typeof row.bookingId !== "string" ||
    !UUID.test(row.bookingId) ||
    row.status !== "Confirmed" ||
    !instant(row.startAt) ||
    row.startAt !== requestedStartAt ||
    !instant(row.endAt) ||
    !instant(row.occupiedUntil) ||
    row.startAt >= row.endAt ||
    row.endAt > row.occupiedUntil ||
    typeof row.priceKopecks !== "string" ||
    !/^(0|[1-9]\d{0,18})$/.test(row.priceKopecks) ||
    BigInt(row.priceKopecks) > 9223372036854775807n
  ) {
    return null;
  }
  return {
    bookingId: row.bookingId,
    status: row.status,
    startAt: row.startAt,
    endAt: row.endAt,
    occupiedUntil: row.occupiedUntil,
    priceKopecks: row.priceKopecks,
  };
}
