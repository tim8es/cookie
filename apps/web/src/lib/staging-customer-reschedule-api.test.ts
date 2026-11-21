import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readRescheduleCutoff,
  rescheduleOwnBooking,
} from "./staging-customer-reschedule-api";

const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  customerId: "22222222-2222-4222-8222-222222222222",
  accessToken: "synthetic-test-bearer",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
};
const bookingId = "33333333-3333-4333-8333-333333333333";
const next = "2028-12-15T12:00:00.000Z";
const key = "stable-move-key-12345678";
const root =
  "/v1/organizations/" + session.tenantId + "/staging-customer-reschedule";
const receipt = {
  bookingId,
  status: "Confirmed",
  previousStartAt: "2028-12-14T10:00:00.000Z",
  startAt: next,
  endAt: "2028-12-15T13:00:00.000Z",
  occupiedUntil: "2028-12-15T13:10:00.000Z",
  priceKopecks: "100000",
};

test("staging reschedule capability has no implicit default", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, root + "/capability");
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    return Response.json({ cutoffMinutes: 30 });
  };
  assert.equal(await readRescheduleCutoff(session, fetcher), 30);
  assert.equal(
    await readRescheduleCutoff(session, async () =>
      Response.json({}, { status: 404 }),
    ),
    null,
  );
  for (const raw of [-1, 0.5, "60", 525601, null]) {
    assert.equal(
      await readRescheduleCutoff(session, async () =>
        Response.json({ cutoffMinutes: raw }),
      ),
      null,
    );
  }
});

test("reschedule repeats original command and key after missing response", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(url, root + "/" + bookingId);
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.deepEqual(JSON.parse(String(init?.body)), { newStartAt: next });
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer " + session.accessToken,
    );
    assert.equal(new Headers(init?.headers).get("idempotency-key"), key);
    if (requests === 1) throw new Error("lost response");
    return Response.json(receipt);
  };
  await assert.rejects(
    rescheduleOwnBooking(session, bookingId, next, key, fetcher),
    /uncertain/,
  );
  assert.deepEqual(
    await rescheduleOwnBooking(session, bookingId, next, key, fetcher),
    receipt,
  );
  assert.equal(requests, 2);
});

test("reschedule never assumes success from malformed or denied responses", async () => {
  for (const raw of [
    { ...receipt, bookingId: session.customerId },
    { ...receipt, status: "Pending" },
    { ...receipt, priceKopecks: "not-price" },
    { ...receipt, extra: true },
    { ...receipt, startAt: receipt.previousStartAt },
    { ...receipt, previousStartAt: receipt.startAt },
  ]) {
    await assert.rejects(
      rescheduleOwnBooking(session, bookingId, next, key, async () =>
        Response.json(raw),
      ),
      /uncertain/,
    );
  }
  await assert.rejects(
    rescheduleOwnBooking(session, bookingId, next, key, async () =>
      Response.json(receipt, { status: 201 }),
    ),
    /uncertain/,
  );
  await assert.rejects(
    rescheduleOwnBooking(session, bookingId, next, key, async () =>
      Response.json({ error: "RESCHEDULE_NOT_AVAILABLE" }, { status: 409 }),
    ),
    /conflict/,
  );
  await assert.rejects(
    rescheduleOwnBooking(session, bookingId, next, key, async () =>
      Response.json({}, { status: 403 }),
    ),
    /denied/,
  );
  let called = false;
  const noFetch: typeof fetch = async () => {
    called = true;
    return Response.json(receipt);
  };
  await assert.rejects(
    rescheduleOwnBooking(
      session,
      bookingId,
      "2027-02-30T10:00:00.000Z",
      key,
      noFetch,
    ),
    /uncertain/,
  );
  await assert.rejects(
    rescheduleOwnBooking(session, bookingId, next, "short", noFetch),
    /uncertain/,
  );
  await assert.rejects(
    rescheduleOwnBooking(
      { ...session, expiresAtUnixSeconds: 0 },
      bookingId,
      next,
      key,
      noFetch,
    ),
    /denied/,
  );
  assert.equal(called, false);
});
