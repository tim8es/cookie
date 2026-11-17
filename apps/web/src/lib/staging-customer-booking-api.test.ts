import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canCreateCustomerBooking,
  customerBookingAttempt,
  type CustomerBookingSelection,
} from "./staging-customer-booking-api";

const tenant = "11111111-1111-4111-8111-111111111111";
const session = {
  tenantId: tenant,
  customerId: "22222222-2222-4222-8222-222222222222",
  accessToken: "synthetic-verified-bearer",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
};
const selection: CustomerBookingSelection = {
  offer: {
    locationId: "33333333-3333-4333-8333-333333333333",
    staffId: "44444444-4444-4444-8444-444444444444",
    serviceId: "55555555-5555-4555-8555-555555555555",
    locationName: "Branch",
    staffName: "Staff",
    serviceName: "Service",
    timeZone: "UTC",
    durationMinutes: 60,
    basePriceKopecks: "100000",
  },
  localDate: "2028-12-14",
  startAt: "2028-12-14T10:00:00.000Z",
};
const receipt = {
  bookingId: "66666666-6666-4666-8666-666666666666",
  status: "Confirmed",
  startAt: selection.startAt,
  endAt: "2028-12-14T11:00:00.000Z",
  occupiedUntil: "2028-12-14T11:15:00.000Z",
  priceKopecks: "125050",
};

test("booking capability is opt-in and requires exact response", async () => {
  const off = async () => Response.json({ enabled: true }, { status: 404 });
  assert.equal(await canCreateCustomerBooking(session, off), false);
  const on = async () => Response.json({ enabled: true });
  assert.equal(await canCreateCustomerBooking(session, on), true);
  const malformed = async () => Response.json({ enabled: "true" });
  assert.equal(await canCreateCustomerBooking(session, malformed), false);
});

test("lost response retries the original selection and key", async () => {
  const requests: Array<{ key: string | null; body: unknown }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const expected = "/v1/organizations/" + tenant;
    assert.equal(url, expected + "/staging-customer-bookings");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    const headers = new Headers(init?.headers);
    const authorization = "Bearer " + session.accessToken;
    assert.equal(headers.get("authorization"), authorization);
    const body: unknown = JSON.parse(String(init?.body));
    requests.push({ key: headers.get("idempotency-key"), body });
    if (requests.length === 1) throw new Error("lost response");
    return Response.json(receipt, { status: 201 });
  };
  const flow = customerBookingAttempt(session, "stable-key", fetcher);
  assert.equal((await flow.submit(selection)).phase, "error");
  assert.equal(flow.reset(), false);
  assert.deepEqual(await flow.retry(), { phase: "confirmed", receipt });
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0], {
    key: "stable-key",
    body: {
      locationId: selection.offer.locationId,
      staffId: selection.offer.staffId,
      serviceId: selection.offer.serviceId,
      startAt: selection.startAt,
    },
  });
});

test("a successful but wrong HTTP status or time never confirms", async () => {
  const wrongStatusFetch = async () => Response.json(receipt);
  const wrongStatus = customerBookingAttempt(
    session,
    "stable-key",
    wrongStatusFetch,
  );
  assert.equal((await wrongStatus.submit(selection)).phase, "error");
  const wrongReceipt = { ...receipt, startAt: receipt.endAt };
  const wrongFetch = async () => Response.json(wrongReceipt, { status: 201 });
  const wrongTime = customerBookingAttempt(session, "stable-key", wrongFetch);
  assert.equal((await wrongTime.submit(selection)).phase, "error");
});

test("verified conflict refreshes slots without new POST", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    if (init?.method === "POST") {
      return Response.json({ error: "BOOKING_CONFLICT" }, { status: 409 });
    }
    return Response.json({
      localDate: selection.localDate,
      timeZone: selection.offer.timeZone,
      slots: [],
    });
  };
  const flow = customerBookingAttempt(session, "stable-key", fetcher);
  assert.deepEqual(await flow.submit(selection), {
    phase: "conflict",
    slots: [],
    refreshFailed: false,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /staging-customer-slots/);
});
