import type { VerifiedCustomerSession } from "./owner-auth.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;

export interface CustomerRescheduleReceipt {
  readonly bookingId: string;
  readonly status: "Confirmed";
  readonly previousStartAt: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly occupiedUntil: string;
  readonly priceKopecks: string;
}
export class CustomerRescheduleError extends Error {
  constructor(readonly reason: "denied" | "conflict" | "uncertain") {
    super(reason);
  }
}
const privacy = {
  cache: "no-store",
  credentials: "omit",
  referrerPolicy: "no-referrer",
  redirect: "error",
} as const;
const endpoint = (session: VerifiedCustomerSession): string =>
  "/v1/organizations/" + session.tenantId + "/staging-customer-reschedule";
function authorization(session: VerifiedCustomerSession): string {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new CustomerRescheduleError("denied");
  return "Bearer " + session.accessToken;
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    INSTANT.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export async function readRescheduleCutoff(
  session: VerifiedCustomerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<number | null> {
  try {
    const response = await fetcher(endpoint(session) + "/capability", {
      ...privacy,
      method: "GET",
      headers: { authorization: authorization(session) },
    });
    if (response.status !== 200) return null;
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (Object.keys(raw).length !== 1 || !("cutoffMinutes" in raw)) return null;
    const minutes = raw.cutoffMinutes;
    return typeof minutes === "number" &&
      Number.isSafeInteger(minutes) &&
      minutes >= 0 &&
      minutes <= 525600
      ? minutes
      : null;
  } catch {
    return null;
  }
}
export interface CustomerRescheduleSlot {
  readonly startAt: string;
  readonly endAt: string;
}
export interface CustomerRescheduleSlots {
  readonly localDate: string;
  readonly timeZone: string;
  readonly slots: CustomerRescheduleSlot[];
}

function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const timestamp = Date.parse(value + "T00:00:00Z");
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}
function timeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
function branchLocalDate(value: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const field = (kind: string) =>
    parts.find((part) => part.type === kind)?.value ?? "";
  return field("year") + "-" + field("month") + "-" + field("day");
}
/** Provisional own-Booking slots. Never a booking hold or confirmation. */
export async function readRescheduleSlots(
  session: VerifiedCustomerSession,
  bookingId: string,
  date: string,
  expectedTimeZone: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CustomerRescheduleSlots> {
  if (!UUID.test(bookingId) || !localDate(date) || !timeZone(expectedTimeZone))
    throw new CustomerRescheduleError("uncertain");
  const auth = authorization(session);
  let response: Response;
  try {
    response = await fetcher(
      endpoint(session) +
        "/" +
        bookingId +
        "/slots?" +
        new URLSearchParams({ localDate: date }).toString(),
      { ...privacy, method: "GET", headers: { authorization: auth } },
    );
  } catch {
    throw new CustomerRescheduleError("uncertain");
  }
  if (response.status === 401 || response.status === 403)
    throw new CustomerRescheduleError("denied");
  if (response.status === 404 || response.status === 409)
    throw new CustomerRescheduleError("conflict");
  if (response.status !== 200) throw new CustomerRescheduleError("uncertain");
  return parseRescheduleSlotsResponse(
    await response.json().catch(() => undefined),
    date,
    expectedTimeZone,
  );
}

/** Shared strict wire validation for owner and customer slot previews. */
export function parseRescheduleSlotsResponse(
  raw: unknown,
  date: string,
  expectedTimeZone: string,
): CustomerRescheduleSlots {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new CustomerRescheduleError("uncertain");
  const data = raw as Partial<CustomerRescheduleSlots>;
  if (
    Object.keys(data).length !== 3 ||
    data.localDate !== date ||
    data.timeZone !== expectedTimeZone ||
    !timeZone(data.timeZone) ||
    !Array.isArray(data.slots) ||
    data.slots.length > 1500 ||
    !data.slots.every((item: unknown): item is CustomerRescheduleSlot => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const slot = item as Partial<CustomerRescheduleSlot>;
      return (
        Object.keys(slot).length === 2 &&
        instant(slot.startAt) &&
        instant(slot.endAt) &&
        slot.startAt < slot.endAt &&
        branchLocalDate(slot.startAt, data.timeZone!) === date
      );
    }) ||
    new Set(data.slots.map((slot) => slot.startAt)).size !==
      data.slots.length ||
    data.slots.some(
      (slot, index) =>
        index > 0 && data.slots![index - 1]!.startAt >= slot.startAt,
    )
  )
    throw new CustomerRescheduleError("uncertain");
  return { localDate: date, timeZone: data.timeZone, slots: data.slots };
}

export async function rescheduleOwnBooking(
  session: VerifiedCustomerSession,
  bookingId: string,
  newStartAt: string,
  key: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CustomerRescheduleReceipt> {
  if (!UUID.test(bookingId) || !KEY.test(key) || !instant(newStartAt))
    throw new CustomerRescheduleError("uncertain");
  const auth = authorization(session);
  let response: Response;
  try {
    response = await fetcher(endpoint(session) + "/" + bookingId, {
      ...privacy,
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ newStartAt }),
    });
  } catch {
    throw new CustomerRescheduleError("uncertain");
  }
  if (response.status === 401 || response.status === 403)
    throw new CustomerRescheduleError("denied");
  const raw: unknown = await response.json().catch(() => undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new CustomerRescheduleError("uncertain");
  if (
    (response.status === 404 || response.status === 409) &&
    Object.keys(raw).length === 1 &&
    "error" in raw &&
    [
      "BOOKING_NOT_FOUND",
      "BOOKING_NOT_CONFIRMED",
      "RESCHEDULE_NOT_AVAILABLE",
      "RESCHEDULE_CONFLICT",
      "RESCHEDULE_POLICY_DENIED",
      "IDEMPOTENCY_KEY_REUSED",
    ].includes(String(raw.error))
  )
    throw new CustomerRescheduleError("conflict");
  const row = raw as Partial<CustomerRescheduleReceipt>;
  if (
    response.status !== 200 ||
    Object.keys(row).length !== 7 ||
    row.bookingId !== bookingId ||
    row.status !== "Confirmed" ||
    !instant(row.previousStartAt) ||
    !instant(row.startAt) ||
    !instant(row.endAt) ||
    !instant(row.occupiedUntil) ||
    row.startAt !== newStartAt ||
    row.startAt >= row.endAt ||
    row.endAt > row.occupiedUntil ||
    row.previousStartAt === row.startAt ||
    typeof row.priceKopecks !== "string" ||
    !/^(0|[1-9]\d{0,11})$/.test(row.priceKopecks)
  )
    throw new CustomerRescheduleError("uncertain");
  return row as CustomerRescheduleReceipt;
}
