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
const receipt = {
  bookingId,
  status: "CancelledByClient",
  cancelledAt: "2028-12-14T10:00:00.000Z",
};

test("cancellation requires explicit capability and exact receipt", async () => {
  const off = async () => Response.json({}, { status: 404 });
  assert.equal(await readCancellationCutoff(session, off), null);
  const on = async () => Response.json({ cutoffMinutes: 60 });
  assert.equal(await readCancellationCutoff(session, on), 60);
  const fetcher: typeof fetch = async (url, init) => {
    const expected = "/staging-customer-cancellation/" + bookingId;
    assert.ok(String(url).endsWith(expected));
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("idempotency-key"), "stable-key");
    return Response.json(receipt);
  };
  const result = await cancelOwnBooking(
    session,
    bookingId,
    "stable-key",
    fetcher,
  );
  assert.deepEqual(result, receipt);
});

test("malformed cancellation cannot be presented as success", async () => {
  for (const raw of [
    { ...receipt, status: "CancelledByBusiness" },
    { ...receipt, bookingId: "wrong" },
    { ...receipt, cancelledAt: "invalid" },
  ]) {
    const fetcher = async () => Response.json(raw);
    await assert.rejects(
      cancelOwnBooking(session, bookingId, "stable-key", fetcher),
      /uncertain/,
    );
  }
});
