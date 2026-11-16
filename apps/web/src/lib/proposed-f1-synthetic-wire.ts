import { TransportFailure } from "./transport.js";
import type { VerifiedBookingConflict } from "./booking-attempt.js";
import type { ConfirmedBookingReceiptView } from "./booking-attempt-view.js";

/**
 * Review-only decoder for the PROPOSED F1 synthetic, staff-assisted wire contract:
 * packages/contracts/openapi/f1-synthetic-v1.yaml (backend Draft #110 / #100).
 *
 * This is NOT a production client API, verified session or public booking flow.
 * It never sends HTTP requests, resolves tenant/customer identity, computes
 * availability, chooses prices or authenticates any response's origin.
 * Nothing in App.svelte or api.ts imports it. #22/#66 approval is required
 * before a trusted adapter may use it.
 */
export interface ProposedF1ConfirmedReceipt {
  bookingId: string;
  status: "Confirmed";
  startAt: string;
  endAt: string;
  occupiedUntil: string;
  priceKopecks: string;
}

export interface ProposedF1AvailableSlot {
  startAt: string;
  endAt: string;
  occupiedUntil: string;
}

export interface ProposedF1Availability {
  /** Null means the backend did not find an active service/staff assignment. */
  priceKopecks: string | null;
  /** UTC intervals from the backend, not a promise of free time at submit. */
  slots: ProposedF1AvailableSlot[];
}

const RECEIPT_KEYS = [
  "bookingId",
  "status",
  "startAt",
  "endAt",
  "occupiedUntil",
  "priceKopecks",
] as const;
const SLOT_KEYS = ["startAt", "endAt", "occupiedUntil"] as const;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DECIMAL_KOPECKS = /^\d+$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function utcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_ISO.test(value)) return false;
  const date = new Date(value);
  // Date.parse normalizes impossible calendar days. Reject them explicitly.
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function price(value: unknown): value is string {
  // OpenAPI uses decimal-string kopecks, never JS floating-point roubles.
  return typeof value === "string" && DECIMAL_KOPECKS.test(value);
}

function parseSlot(value: unknown): ProposedF1AvailableSlot | null {
  if (!record(value) || !exactKeys(value, SLOT_KEYS)) return null;
  if (
    !utcInstant(value.startAt) ||
    !utcInstant(value.endAt) ||
    !utcInstant(value.occupiedUntil)
  )
    return null;
  // Compare instants, not ISO strings with differing fractional precision.
  if (
    !(
      Date.parse(value.startAt) < Date.parse(value.endAt) &&
      Date.parse(value.endAt) <= Date.parse(value.occupiedUntil)
    )
  )
    return null;
  return {
    startAt: value.startAt,
    endAt: value.endAt,
    occupiedUntil: value.occupiedUntil,
  };
}

/** Rejects Pending, malformed, extra-field or chronologically inconsistent data. */
export function parseProposedF1ConfirmedReceipt(
  value: unknown,
): ProposedF1ConfirmedReceipt | null {
  if (!record(value) || !exactKeys(value, RECEIPT_KEYS)) return null;
  if (
    value.status !== "Confirmed" ||
    typeof value.bookingId !== "string" ||
    !UUID.test(value.bookingId) ||
    !price(value.priceKopecks)
  )
    return null;
  const slot = parseSlot({
    startAt: value.startAt,
    endAt: value.endAt,
    occupiedUntil: value.occupiedUntil,
  });
  if (!slot) return null;
  return {
    bookingId: value.bookingId,
    status: "Confirmed",
    ...slot,
    priceKopecks: value.priceKopecks,
  };
}

/**
 * Keeps the current server BASE price separate from confirmed price.
 * The slot list must not be converted to a local wall clock without the
 * trusted Location IANA timezone from the reviewed server context.
 */
export function parseProposedF1Availability(
  value: unknown,
): ProposedF1Availability | null {
  if (
    !record(value) ||
    !exactKeys(value, ["priceKopecks", "slots"]) ||
    (value.priceKopecks !== null && !price(value.priceKopecks)) ||
    !Array.isArray(value.slots)
  )
    return null;
  const slots: ProposedF1AvailableSlot[] = [];
  for (const item of value.slots) {
    const slot = parseSlot(item);
    if (!slot) return null;
    slots.push(slot);
  }
  if (value.priceKopecks === null && slots.length !== 0) return null;
  return { priceKopecks: value.priceKopecks, slots };
}

/** Strict error classification: raw/unrecognized HTTP 409 stays unverified. */
export function classifyProposedF1Conflict(
  reason: unknown,
): VerifiedBookingConflict {
  if (
    !(reason instanceof TransportFailure) ||
    reason.kind !== "conflict" ||
    reason.status !== 409 ||
    !record(reason.responseBody) ||
    !exactKeys(reason.responseBody, ["error"])
  )
    return "unknown";
  const wrapper = reason.responseBody.error;
  if (!record(wrapper) || !exactKeys(wrapper, ["code"])) return "unknown";
  if (wrapper.code === "BOOKING_CONFLICT") return "slot-unavailable";
  if (wrapper.code === "IDEMPOTENCY_KEY_REUSED")
    return "idempotency-key-reused";
  return "unknown";
}

/** Exact kopecks, no float conversion, discounts or client-side price calculation. */
export function formatProposedKopecks(kopecks: string): string | null {
  if (!price(kopecks)) return null;
  const normalized = kopecks.replace(/^0+(?=\d)/, "");
  const whole = normalized.length > 2 ? normalized.slice(0, -2) : "0";
  const fraction = normalized.slice(-2).padStart(2, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return grouped + (fraction === "00" ? "" : "," + fraction) + " ₽";
}

/**
 * Pure presentation mapper. Shape validation does NOT substitute for a
 * trusted/authenticated HTTP client. No data from here is persisted as a booking.
 * UTC is explicit because this synthetic receipt does not return a location zone.
 */
export function proposedF1ReceiptView(
  value: unknown,
): ConfirmedBookingReceiptView | null {
  const receipt = parseProposedF1ConfirmedReceipt(value);
  if (!receipt) return null;
  const amount = formatProposedKopecks(receipt.priceKopecks);
  if (!amount) return null;
  const start = receipt.startAt;
  return {
    bookingId: receipt.bookingId,
    dateTimeText: `${start.slice(8, 10)}.${start.slice(5, 7)}.${start.slice(0, 4)}, ${start.slice(11, 16)} UTC`,
    finalPriceText: amount,
  };
}
