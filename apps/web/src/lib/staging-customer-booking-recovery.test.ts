import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverCustomerBooking } from "./staging-customer-booking-api";

const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  customerId: "22222222-2222-4222-8222-222222222222",
  accessToken: "synthetic-bearer",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
};
const key = "33333333-3333-4333-8333-333333333333";
const receipt = {
  bookingId: "44444444-4444-4444-8444-444444444444",
  status: "Confirmed",
  startAt: "2028-12-14T10:00:00.000Z",
  endAt: "2028-12-14T11:00:00.000Z",
  occupiedUntil: "2028-12-14T11:15:00.000Z",
  priceKopecks: "125050",
};

test("receipt recovery is a read-only request using the original key", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/staging-customer-bookings/receipt"));
    assert.ok(!String(url).includes(key));
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("idempotency-key"), key);
    const auth = "Bearer " + session.accessToken;
    assert.equal(headers.get("authorization"), auth);
    return Response.json(receipt);
  };
  assert.deepEqual(await recoverCustomerBooking(session, key, fetcher), receipt);
});

test("receipt absence, denial or corruption is not a resolved result", async () => {
  for (const status of [401, 403, 404, 409, 503]) {
    const fetcher = async () => Response.json(receipt, { status });
    assert.equal(await recoverCustomerBooking(session, key, fetcher), null);
  }
  const pending = { ...receipt, status: "Pending" };
  const malformed = async () => Response.json(pending);
  assert.equal(await recoverCustomerBooking(session, key, malformed), null);
  const expired = { ...session, expiresAtUnixSeconds: 0 };
  let calls = 0;
  const never = async () => {
    calls++;
    return Response.json(receipt);
  };
  assert.equal(await recoverCustomerBooking(expired, key, never), null);
  assert.equal(calls, 0);
});
