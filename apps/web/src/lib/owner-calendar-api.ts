import type { VerifiedOwnerSession } from "./owner-auth";

export const calendarStatuses = [
  "Confirmed",
  "CancelledByClient",
  "CancelledByBusiness",
  "Completed",
  "NoShow",
] as const;
export type CalendarStatus = (typeof calendarStatuses)[number];
export type CalendarDays = 1 | 7;
interface BookingEntry {
  readonly id: string;
  readonly status: CalendarStatus;
  readonly startAt: string;
  readonly endAt: string;
  readonly staffName: string;
  readonly serviceName: string;
  readonly priceKopecks: string;
}
export interface OwnerCalendarEntry extends BookingEntry {
  // Optional for compatibility with an older server during rolling updates.
  readonly staffId?: string;
}
export interface OwnerCalendar {
  readonly locationId: string;
  readonly localDate: string;
  readonly days: CalendarDays;
  readonly timeZone: string;
  readonly rangeStartAt?: string;
  readonly rangeEndAt?: string;
  readonly entries: OwnerCalendarEntry[];
}
export class CalendarReadError extends Error {
  constructor(
    readonly reason:
      | "unauthorized"
      | "invalid-period"
      | "branch-unavailable"
      | "period-too-dense"
      | "invalid-response"
      | "unavailable",
  ) {
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
function name(value: unknown): value is string {
  return (
    typeof value === "string" && !!value.trim() && [...value].length <= 200
  );
}
function zone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function entry(value: unknown): value is BookingEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BookingEntry>;
  return (
    typeof item.id === "string" &&
    UUID.test(item.id) &&
    calendarStatuses.includes(item.status as CalendarStatus) &&
    instant(item.startAt) &&
    instant(item.endAt) &&
    Date.parse(item.endAt) > Date.parse(item.startAt) &&
    Date.parse(item.endAt) - Date.parse(item.startAt) <= 86400000 &&
    name(item.staffName) &&
    name(item.serviceName) &&
    typeof item.priceKopecks === "string" &&
    /^(0|[1-9]\d{0,11})$/.test(item.priceKopecks)
  );
}

function calendarEntry(value: unknown): value is OwnerCalendarEntry {
  return (
    entry(value) &&
    (!("staffId" in value) ||
      (typeof value.staffId === "string" && UUID.test(value.staffId)))
  );
}

export async function readOwnerCalendar(
  session: VerifiedOwnerSession,
  locationId: string,
  localDate: string,
  days: CalendarDays,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<OwnerCalendar> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new CalendarReadError("unauthorized");
  if (
    !UUID.test(session.tenantId) ||
    !UUID.test(locationId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(localDate) ||
    (days !== 1 && days !== 7)
  )
    throw new CalendarReadError("invalid-period");
  const query = new URLSearchParams({
    locationId,
    date: localDate,
    days: String(days),
  });
  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" + session.tenantId + "/owner-calendar?" + query,
      {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { authorization: "Bearer " + session.accessToken },
        signal,
      },
    );
  } catch {
    throw new CalendarReadError("unavailable");
  }
  if (response.status === 401 || response.status === 403)
    throw new CalendarReadError("unauthorized");
  if (response.status === 404)
    throw new CalendarReadError("branch-unavailable");
  if (response.status === 400 || response.status === 422)
    throw new CalendarReadError("invalid-period");
  if (response.status === 409) throw new CalendarReadError("period-too-dense");
  if (response.status !== 200) throw new CalendarReadError("unavailable");
  try {
    const data = (await response.json()) as Partial<OwnerCalendar>;
    if (
      !data ||
      data.locationId !== locationId ||
      data.localDate !== localDate ||
      data.days !== days ||
      !zone(data.timeZone) ||
      !Array.isArray(data.entries) ||
      data.entries.length > 500 ||
      !data.entries.every(calendarEntry) ||
      new Set(data.entries.map((e) => e.id)).size !== data.entries.length
    )
      throw new Error("invalid");
    const from = data.rangeStartAt;
    const to = data.rangeEndAt;
    const hasRange = "rangeStartAt" in data || "rangeEndAt" in data;
    if (hasRange) {
      if (!instant(from) || !instant(to)) throw new Error("invalid range");
      const start = Date.parse(from);
      const end = Date.parse(to);
      if (end <= start || end - start > (days + 1) * 86400000) {
        throw new Error("invalid range");
      }
      for (const item of data.entries) {
        const startsOutside = Date.parse(item.startAt) >= end;
        const endsOutside = Date.parse(item.endAt) <= start;
        if (startsOutside || endsOutside) {
          throw new Error("entry outside range");
        }
      }
    }
    return {
      locationId,
      localDate,
      days,
      timeZone: data.timeZone,
      ...(from && to ? { rangeStartAt: from, rangeEndAt: to } : {}),
      entries: data.entries.map(
        ({
          id,
          status,
          startAt,
          endAt,
          staffName,
          staffId,
          serviceName,
          priceKopecks,
        }) => ({
          id,
          status,
          startAt,
          endAt,
          staffName,
          ...(staffId === undefined ? {} : { staffId }),
          serviceName,
          priceKopecks,
        }),
      ),
    };
  } catch {
    throw new CalendarReadError("invalid-response");
  }
}

export interface OwnerBookingDetail extends BookingEntry {
  readonly locationId: string;
  readonly timeZone: string;
  readonly durationMinutes: number;
  readonly bufferMinutes: number;
  readonly occupiedUntil: string;
  readonly cancelledAt: string | null;
}

export class BookingDetailReadError extends Error {
  constructor(
    readonly reason:
      | "unauthorized"
      | "not-found"
      | "invalid-response"
      | "unavailable",
  ) {
    super(reason);
  }
}

/** Never derive details from stale calendar entries or cache the response. */
export async function readOwnerBookingDetail(
  session: VerifiedOwnerSession,
  locationId: string,
  bookingId: string,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<OwnerBookingDetail> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new BookingDetailReadError("unauthorized");
  if (![session.tenantId, locationId, bookingId].every((id) => UUID.test(id)))
    throw new BookingDetailReadError("invalid-response");
  let response: Response;
  try {
    const root = "/v1/organizations/" + session.tenantId + "/owner-calendar/";
    const query = new URLSearchParams({ locationId });
    response = await fetcher(root + bookingId + "?" + query, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { authorization: "Bearer " + session.accessToken },
      signal,
    });
  } catch {
    throw new BookingDetailReadError("unavailable");
  }
  if (response.status === 401 || response.status === 403)
    throw new BookingDetailReadError("unauthorized");
  if (response.status === 404) throw new BookingDetailReadError("not-found");
  if (response.status !== 200) throw new BookingDetailReadError("unavailable");
  try {
    const value: unknown = await response.json();
    if (!entry(value)) throw new Error("invalid");
    const detail = value as OwnerBookingDetail;
    const duration = detail.durationMinutes;
    const buffer = detail.bufferMinutes;
    const cancelled = ["CancelledByClient", "CancelledByBusiness"].includes(
      detail.status,
    );
    const validCancellation = cancelled
      ? instant(detail.cancelledAt)
      : detail.cancelledAt === null;
    if (
      Object.keys(detail).length !== 13 ||
      detail.id !== bookingId ||
      detail.locationId !== locationId ||
      !zone(detail.timeZone) ||
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 1440 ||
      !Number.isInteger(buffer) ||
      buffer < 0 ||
      buffer > 1440 ||
      !instant(detail.occupiedUntil) ||
      !validCancellation ||
      Date.parse(detail.endAt) - Date.parse(detail.startAt) !==
        duration * 60000 ||
      Date.parse(detail.occupiedUntil) - Date.parse(detail.endAt) !==
        buffer * 60000
    )
      throw new Error("invalid");
    if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
      throw new BookingDetailReadError("unauthorized");
    return detail;
  } catch (error) {
    if (error instanceof BookingDetailReadError) throw error;
    throw new BookingDetailReadError("invalid-response");
  }
}
