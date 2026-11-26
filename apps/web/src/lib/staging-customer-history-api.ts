import type { VerifiedCustomerSession } from "./owner-auth.js";

const STATUSES = [
  "Confirmed",
  "CancelledByClient",
  "CancelledByBusiness",
  "Completed",
  "NoShow",
] as const;
export type CustomerBookingStatus = (typeof STATUSES)[number];

export interface OwnBooking {
  bookingId: string;
  status: CustomerBookingStatus;
  startAt: string;
  endAt: string;
  priceKopecks: string;
  locationName: string;
  staffName: string;
  serviceName: string;
  timeZone: string | null;
}

export interface OwnBookingHistory {
  bookings: OwnBooking[];
  hasMore: boolean;
}

export class CustomerHistoryError extends Error {
  constructor(readonly reason: "unauthorized" | "unavailable") {
    super(reason);
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function label(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 400
  );
}

function zone(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isBooking(value: unknown): value is OwnBooking {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<OwnBooking>;
  return (
    Object.keys(row).length === 9 &&
    typeof row.bookingId === "string" &&
    UUID.test(row.bookingId) &&
    row.status !== undefined &&
    STATUSES.includes(row.status) &&
    instant(row.startAt) &&
    instant(row.endAt) &&
    row.startAt < row.endAt &&
    typeof row.priceKopecks === "string" &&
    /^(0|[1-9]\d{0,11})$/.test(row.priceKopecks) &&
    label(row.locationName) &&
    label(row.staffName) &&
    label(row.serviceName) &&
    zone(row.timeZone)
  );
}

export async function readOwnBookings(
  session: VerifiedCustomerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<OwnBookingHistory> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds) {
    throw new CustomerHistoryError("unauthorized");
  }
  const path = "/v1/organizations/" + session.tenantId;
  let response: Response;
  try {
    response = await fetcher(path + "/staging-customer-history", {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { authorization: "Bearer " + session.accessToken },
    });
  } catch {
    throw new CustomerHistoryError("unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new CustomerHistoryError("unauthorized");
  }
  if (response.status !== 200) {
    throw new CustomerHistoryError("unavailable");
  }
  const raw: unknown = await response.json().catch(() => undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CustomerHistoryError("unavailable");
  }
  const data = raw as Partial<OwnBookingHistory>;
  if (
    Object.keys(data).length !== 2 ||
    typeof data.hasMore !== "boolean" ||
    !Array.isArray(data.bookings) ||
    data.bookings.length > 200 ||
    (data.hasMore && data.bookings.length !== 200) ||
    !data.bookings.every(isBooking) ||
    new Set(data.bookings.map((row) => row.bookingId)).size !==
      data.bookings.length
  ) {
    throw new CustomerHistoryError("unavailable");
  }
  return { bookings: data.bookings, hasMore: data.hasMore };
}
