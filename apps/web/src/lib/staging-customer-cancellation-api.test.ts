import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelOwnBooking,
  readCancellationCutoff,
} from "./staging-customer-cancellation-api";

const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  customerId: "22222222-2222-4222-8222-222222222222",
  accessToken: "synthetic-bearer",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
};
const bookingId = "33333333-3333-4333-8333-333333333333";
const key = "stable-cancel-key-123456";
const root = "/v1/organizations/" + session.tenantId + "/staging-customer-cancellation";
const receipt = {
  bookingId,
  status: "CancelledByClient",
  cancelledAt: "2028-12-14T10:00:00.000Z",
};

test("cancellation capability requires an exact server policy", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, root + "/capability");
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + session.accessToken);
    return Response.json({ cutoffMinutes: 0 });
  };
  assert.equal(await readCancellationCutoff(session, fetcher), 0);
  assert.equal(await readCancellationCutoff(session, async () => Response.json({}, { status: 404 })), null);
  for (const value of [-1, 0.5, "60", 525601]) {
    assert.equal(await readCancellationCutoff(session, async () => Response.json({ cutoffMinutes: value })), null);
  }
  assert.equal(await readCancellationCutoff(session, async () => Response.json({ cutoffMinutes: 60, extra: true })), null);
});

test("cancellation uses the same key after an unknown wire outcome", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(url, root + "/" + bookingId);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer " + session.accessToken);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("idempotency-key"), key);
    if (requests === 1) throw new Error("synthetic lost response");
    return Response.json(receipt);
  };
  await assert.rejects(cancelOwnBooking(session, bookingId, key, fetcher), /uncertain/);
  assert.deepEqual(await cancelOwnBooking(session, bookingId, key, fetcher), receipt);
  assert.equal(requests, 2);
});

test("only the exact successful cancellation receipt can confirm cancellation", async () => {
  for (const raw of [
    { ...receipt, status: "CancelledByBusiness" },
    { ...receipt, bookingId: session.customerId },
    { ...receipt, cancelledAt: "invalid" },
    { ...receipt, extra: true },
  ]) {
    await assert.rejects(cancelOwnBooking(session, bookingId, key, async () => Response.json(raw)), /uncertain/);
  }
  await assert.rejects(cancelOwnBooking(session, bookingId, key, async () => Response.json(receipt, { status: 201 })), /uncertain/);
  await assert.rejects(cancelOwnBooking(session, bookingId, key, async () => Response.json({ error: "BOOKING_NOT_CONFIRMED" }, { status: 409 })), /conflict/);
  await assert.rejects(cancelOwnBooking(session, bookingId, key, async () => Response.json({}, { status: 403 })), /denied/);
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; return Response.json(receipt); };
  await assert.rejects(cancelOwnBooking(session, bookingId, "short", fetcher), /uncertain/);
  await assert.rejects(cancelOwnBooking({ ...session, expiresAtUnixSeconds: 0 }, bookingId, key, fetcher), /denied/);
  assert.equal(called, false);
});
