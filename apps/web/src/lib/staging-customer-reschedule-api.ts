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
