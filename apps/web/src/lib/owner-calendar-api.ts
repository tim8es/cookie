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
export interface OwnerCalendarEntry {
  readonly id: string;
  readonly status: CalendarStatus;
  readonly startAt: string;
  readonly endAt: string;
  readonly staffName: string;
  readonly serviceName: string;
  readonly priceKopecks: string;
}
export interface OwnerCalendar {
  readonly locationId: string;
  readonly localDate: string;
  readonly days: CalendarDays;
  readonly timeZone: string;
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
function entry(value: unknown): value is OwnerCalendarEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OwnerCalendarEntry>;
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
      !data.entries.every(entry) ||
      new Set(data.entries.map((e) => e.id)).size !== data.entries.length
    )
      throw new Error("invalid");
    return {
      locationId,
      localDate,
      days,
      timeZone: data.timeZone,
      entries: data.entries.map(
        ({
          id,
          status,
          startAt,
          endAt,
          staffName,
          serviceName,
          priceKopecks,
        }) => ({
          id,
          status,
          startAt,
          endAt,
          staffName,
          serviceName,
          priceKopecks,
        }),
      ),
    };
  } catch {
    throw new CalendarReadError("invalid-response");
  }
}
