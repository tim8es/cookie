import {
  BookingAttempt,
  type BookingAttemptPort,
} from "./booking-attempt.js";
import {
  verifyBookingReceipt,
  type ConfirmedBookingReceipt,
} from "./confirmed-booking-receipt.js";
import type { VerifiedCustomerSession } from "./owner-auth.js";
import {
  readCustomerSlots,
  type CustomerOffer,
  type CustomerSlot,
} from "./staging-customer-offers-api.js";
import {
  createJsonTransport,
  TransportFailure,
} from "./transport.js";

export interface CustomerBookingSelection {
  readonly offer: CustomerOffer;
  readonly localDate: string;
  readonly startAt: string;
}

function endpoint(session: VerifiedCustomerSession): string {
  return "/v1/organizations/" + session.tenantId + "/staging-customer-bookings";
}
function headers(session: VerifiedCustomerSession): Record<string, string> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds) {
    throw new TransportFailure("unauthenticated", 401);
  }
  return { authorization: "Bearer " + session.accessToken };
}
const privacy = {
  credentials: "omit",
  cache: "no-store",
  redirect: "error",
  referrerPolicy: "no-referrer",
} as const;

export async function canCreateCustomerBooking(
  session: VerifiedCustomerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(endpoint(session) + "/capability", {
      ...privacy,
      headers: headers(session),
    });
    if (response.status !== 200) return false;
    const body: unknown = await response.json();
    return (
      !!body &&
      typeof body === "object" &&
      Object.keys(body).length === 1 &&
      "enabled" in body &&
      body.enabled === true
    );
  } catch {
    return false;
  }
}

export function customerBookingAttempt(
  session: VerifiedCustomerSession,
  key: string,
  fetcher: typeof fetch = globalThis.fetch,
): BookingAttempt<CustomerBookingSelection, ConfirmedBookingReceipt, CustomerSlot> {
  const transport = createJsonTransport(async (url, init) => {
    const response = await fetcher(url, init);
    if (response.ok && response.status !== 201) {
      return new Response(null, { status: 204 });
    }
    return response;
  });
  const port: BookingAttemptPort<
    CustomerBookingSelection,
    ConfirmedBookingReceipt,
    CustomerSlot
  > = {
    async create(selection, idempotencyKey) {
      // An explicit expired session is not a successful confirmation.
      const authorization = headers(session);
      return transport.request(endpoint(session), {
        ...privacy,
        method: "POST",
        headers: {
          ...authorization,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          locationId: selection.offer.locationId,
          staffId: selection.offer.staffId,
          serviceId: selection.offer.serviceId,
          startAt: selection.startAt,
        }),
      });
    },
    verifyConfirmed(raw, selection) {
      return verifyBookingReceipt(raw, selection.startAt);
    },
    classifyConflict(reason) {
      if (!(reason instanceof TransportFailure)) return "unknown";
      const body = reason.responseBody;
      if (!body || typeof body !== "object") return "unknown";
      if (Object.keys(body).length !== 1 || !("error" in body))
        return "unknown";
      if (body.error === "IDEMPOTENCY_KEY_REUSED")
        return "idempotency-key-reused";
      if (
        body.error === "BOOKING_CONFLICT" ||
        body.error === "BOOKING_NOT_AVAILABLE"
      )
        return "slot-unavailable";
      return "unknown";
    },
    async refreshSlots(selection) {
      const result = await readCustomerSlots(
        session,
        selection.offer,
        selection.localDate,
        fetcher,
      );
      return result.slots;
    },
  };
  return new BookingAttempt(port, () => key);
}
