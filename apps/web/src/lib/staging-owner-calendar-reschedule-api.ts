import type { VerifiedOwnerSession } from "./owner-auth.js";
import {
  parseRescheduleSlotsResponse,
  type CustomerRescheduleReceipt,
  type CustomerRescheduleSlots,
} from "./staging-customer-reschedule-api.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const privacy = {
  cache: "no-store",
  credentials: "omit",
  redirect: "error",
  referrerPolicy: "no-referrer",
} as const;

export type OwnerRescheduleReceipt = CustomerRescheduleReceipt;
export type OwnerRescheduleSlots = CustomerRescheduleSlots;

export class OwnerRescheduleError extends Error {
  constructor(readonly reason: "denied" | "conflict" | "uncertain") {
    super(reason);
  }
}
function authorization(session: VerifiedOwnerSession): string {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new OwnerRescheduleError("denied");
  return "Bearer " + session.accessToken;
}
function endpoint(session: VerifiedOwnerSession): string {
  return "/v1/organizations/" + session.tenantId + "/owner-calendar";
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ts = Date.parse(value + "T00:00:00Z");
  return (
    Number.isFinite(ts) && new Date(ts).toISOString().slice(0, 10) === value
  );
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    INSTANT.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** Absent or malformed server capability keeps the owner UI read-only. */
export async function readStagingOwnerRescheduleCutoff(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<number | null> {
  try {
    const response = await fetcher(
      endpoint(session) + "/reschedule/capability",
      {
        ...privacy,
        method: "GET",
        headers: { authorization: authorization(session) },
      },
    );
    if (response.status !== 200) return null;
    const raw: unknown = await response.json();
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 1 ||
      !("cutoffMinutes" in raw)
    )
      return null;
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

/** Read-only provisional server slots, scoped to the actual booking branch. */
export async function readOwnerRescheduleSlots(
  session: VerifiedOwnerSession,
  locationId: string,
  bookingId: string,
  date: string,
  expectedTimeZone: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<OwnerRescheduleSlots> {
  if (!UUID.test(locationId) || !UUID.test(bookingId) || !validDate(date))
    throw new OwnerRescheduleError("uncertain");
  const auth = authorization(session);
  let response: Response;
  try {
    response = await fetcher(
      endpoint(session) +
        "/" +
        bookingId +
        "/reschedule/slots?" +
        new URLSearchParams({ locationId, localDate: date }).toString(),
      { ...privacy, method: "GET", headers: { authorization: auth } },
    );
  } catch {
    throw new OwnerRescheduleError("uncertain");
  }
  if (response.status === 401 || response.status === 403)
    throw new OwnerRescheduleError("denied");
  if (response.status === 404 || response.status === 409)
    throw new OwnerRescheduleError("conflict");
  if (response.status !== 200) throw new OwnerRescheduleError("uncertain");
  try {
    return parseRescheduleSlotsResponse(
      await response.json(),
      date,
      expectedTimeZone,
    );
  } catch {
    throw new OwnerRescheduleError("uncertain");
  }
}

/** An acknowledged, exactly matching receipt is required for UI success. */
export async function rescheduleOwnerCalendarBooking(
  session: VerifiedOwnerSession,
  locationId: string,
  bookingId: string,
  newStartAt: string,
  key: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<OwnerRescheduleReceipt> {
  if (
    !UUID.test(locationId) ||
    !UUID.test(bookingId) ||
    !KEY.test(key) ||
    !instant(newStartAt)
  )
    throw new OwnerRescheduleError("uncertain");
  const auth = authorization(session);
  let response: Response;
  try {
    response = await fetcher(
      endpoint(session) +
        "/" +
        bookingId +
        "/reschedule?" +
        new URLSearchParams({ locationId }).toString(),
      {
        ...privacy,
        method: "POST",
        headers: {
          authorization: auth,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ newStartAt }),
      },
    );
  } catch {
    throw new OwnerRescheduleError("uncertain");
  }
  if (response.status === 401 || response.status === 403)
    throw new OwnerRescheduleError("denied");
  if (response.status === 404 || response.status === 409)
    throw new OwnerRescheduleError("conflict");
  if (response.status !== 200) throw new OwnerRescheduleError("uncertain");
  const raw: unknown = await response.json().catch(() => undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new OwnerRescheduleError("uncertain");
  const receipt = raw as Partial<OwnerRescheduleReceipt>;
  if (
    Object.keys(receipt).length !== 7 ||
    receipt.bookingId !== bookingId ||
    receipt.status !== "Confirmed" ||
    !instant(receipt.previousStartAt) ||
    !instant(receipt.startAt) ||
    !instant(receipt.endAt) ||
    !instant(receipt.occupiedUntil) ||
    receipt.startAt !== newStartAt ||
    receipt.previousStartAt === receipt.startAt ||
    receipt.startAt >= receipt.endAt ||
    receipt.endAt > receipt.occupiedUntil ||
    typeof receipt.priceKopecks !== "string" ||
    !/^(0|[1-9]\d{0,11})$/.test(receipt.priceKopecks)
  )
    throw new OwnerRescheduleError("uncertain");
  return receipt as OwnerRescheduleReceipt;
}
