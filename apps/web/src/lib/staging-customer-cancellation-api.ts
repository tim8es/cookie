import type { VerifiedCustomerSession } from "./owner-auth.js";

export interface CancellationReceipt {
  bookingId: string;
  status: "CancelledByClient";
  cancelledAt: string;
}

export class CancellationError extends Error {
  constructor(
    readonly reason: "unauthorized" | "denied" | "uncertain",
  ) {
    super(reason);
  }
}

function root(session: VerifiedCustomerSession): string {
  const prefix = "/v1/organizations/" + session.tenantId;
  return prefix + "/staging-customer-cancellation";
}

const privacy = {
  credentials: "omit",
  cache: "no-store",
  redirect: "error",
  referrerPolicy: "no-referrer",
} as const;

function headers(session: VerifiedCustomerSession): Record<string, string> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds) {
    throw new CancellationError("unauthorized");
  }
  return { authorization: "Bearer " + session.accessToken };
}

export async function readCancellationCutoff(
  session: VerifiedCustomerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<number | null> {
  try {
    const response = await fetcher(root(session) + "/capability", {
      ...privacy,
      headers: headers(session),
    });
    if (response.status !== 200) return null;
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (Object.keys(raw).length !== 1 || !("cutoffMinutes" in raw)) {
      return null;
    }
    const value = raw.cutoffMinutes;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 10080
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function cancelOwnBooking(
  session: VerifiedCustomerSession,
  bookingId: string,
  key: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CancellationReceipt> {
  const authorization = headers(session);
  let response: Response;
  try {
    response = await fetcher(root(session) + "/" + bookingId, {
      ...privacy,
      method: "POST",
      headers: { ...authorization, "idempotency-key": key },
    });
  } catch {
    throw new CancellationError("uncertain");
  }
  if (response.status === 401 || response.status === 403) {
    throw new CancellationError("unauthorized");
  }
  const raw: unknown = await response.json().catch(() => null);
  if (
    response.status === 409 &&
    raw &&
    typeof raw === "object" &&
    "error" in raw &&
    raw.error === "CANCELLATION_POLICY_DENIED"
  ) {
    throw new CancellationError("denied");
  }
  if (
    response.status !== 200 ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 3 ||
    !("bookingId" in raw) ||
    raw.bookingId !== bookingId ||
    !("status" in raw) ||
    raw.status !== "CancelledByClient" ||
    !("cancelledAt" in raw) ||
    typeof raw.cancelledAt !== "string" ||
    !Number.isFinite(Date.parse(raw.cancelledAt)) ||
    new Date(raw.cancelledAt).toISOString() !== raw.cancelledAt
  ) {
    throw new CancellationError("uncertain");
  }
  return {
    bookingId,
    status: "CancelledByClient",
    cancelledAt: raw.cancelledAt,
  };
}
