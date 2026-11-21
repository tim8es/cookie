import type { VerifiedOwnerSession } from "./owner-auth.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

export interface OwnerCancellationReceipt {
  readonly bookingId: string;
  readonly status: "CancelledByBusiness";
  readonly cancelledAt: string;
}
export class OwnerCancellationError extends Error {
  constructor(readonly reason: "denied" | "conflict" | "uncertain") {
    super(reason);
  }
}
const privacy = {
  cache: "no-store",
  credentials: "omit",
  redirect: "error",
  referrerPolicy: "no-referrer",
} as const;

function authorization(session: VerifiedOwnerSession): string {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new OwnerCancellationError("denied");
  return "Bearer " + session.accessToken;
}
function endpoint(session: VerifiedOwnerSession): string {
  return "/v1/organizations/" + session.tenantId + "/owner-calendar";
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** Absent/invalid capability disables editing. No client-side policy default. */
export async function readStagingOwnerCancellationCutoff(
  session: VerifiedOwnerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<number | null> {
  try {
    const response = await fetcher(
      endpoint(session) + "/cancellation/capability",
      {
        ...privacy,
        method: "GET",
        headers: { authorization: authorization(session) },
      },
    );
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

export async function cancelOwnerCalendarBooking(
  session: VerifiedOwnerSession,
  locationId: string,
  bookingId: string,
  key: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<OwnerCancellationReceipt> {
  if (
    ![session.tenantId, locationId, bookingId].every((id) => UUID.test(id)) ||
    !KEY.test(key)
  )
    throw new OwnerCancellationError("uncertain");
  const auth = authorization(session);
  let response: Response;
  try {
    response = await fetcher(
      endpoint(session) +
        "/" +
        bookingId +
        "/cancel?" +
        new URLSearchParams({ locationId }).toString(),
      {
        ...privacy,
        method: "POST",
        headers: {
          authorization: auth,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({}),
      },
    );
  } catch {
    throw new OwnerCancellationError("uncertain");
  }
  if (response.status === 401 || response.status === 403)
    throw new OwnerCancellationError("denied");
  if (response.status === 404 || response.status === 409)
    throw new OwnerCancellationError("conflict");
  if (response.status !== 200) throw new OwnerCancellationError("uncertain");
  const raw: unknown = await response.json().catch(() => undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new OwnerCancellationError("uncertain");
  const receipt = raw as Partial<OwnerCancellationReceipt>;
  if (
    Object.keys(receipt).length !== 3 ||
    receipt.bookingId !== bookingId ||
    receipt.status !== "CancelledByBusiness" ||
    !instant(receipt.cancelledAt)
  )
    throw new OwnerCancellationError("uncertain");
  return receipt as OwnerCancellationReceipt;
}
