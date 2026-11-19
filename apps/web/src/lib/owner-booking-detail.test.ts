import assert from "node:assert/strict";
import test from "node:test";

import {
  BookingDetailReadError,
  readOwnerBookingDetail,
} from "./owner-calendar-api";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const locationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bookingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const session = {
  tenantId,
  accessToken: "synthetic-detail-token",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 60,
};
const detail = {
  id: bookingId,
  locationId,
  timeZone: "UTC",
  status: "Confirmed",
  startAt: "2027-05-01T10:00:00.000Z",
  endAt: "2027-05-01T11:00:00.000Z",
  occupiedUntil: "2027-05-01T11:10:00.000Z",
  cancelledAt: null,
  durationMinutes: 60,
  bufferMinutes: 10,
  staffName: "Synthetic staff",
  serviceName: "Synthetic service",
  priceKopecks: "100000",
};

test("booking detail sends a scoped no-store GET and validates snapshot", async () => {
  const controller = new AbortController();
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(
      String(input),
      "/v1/organizations/" +
        tenantId +
        "/owner-calendar/" +
        bookingId +
        "?locationId=" +
        locationId,
    );
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.signal, controller.signal);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer " + session.accessToken,
    );
    return Response.json(detail);
  };
  assert.deepEqual(
    await readOwnerBookingDetail(
      session,
      locationId,
      bookingId,
      fetcher,
      controller.signal,
    ),
    detail,
  );
});

test("booking detail rejects wrong scope, invalid snapshots and private fields", async () => {
  for (const invalid of [
    { ...detail, id: locationId },
    { ...detail, locationId: bookingId },
    { ...detail, durationMinutes: 30 },
    { ...detail, bufferMinutes: -1 },
    { ...detail, occupiedUntil: detail.endAt },
    { ...detail, cancelledAt: detail.startAt },
    { ...detail, status: "CancelledByClient" },
    { ...detail, customerId: "must-not-leak" },
  ]) {
    await assert.rejects(
      readOwnerBookingDetail(session, locationId, bookingId, async () =>
        Response.json(invalid),
      ),
      (error: unknown) =>
        error instanceof BookingDetailReadError &&
        error.reason === "invalid-response",
    );
  }
  for (const [status, reason] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not-found"],
    [503, "unavailable"],
  ] as const) {
    await assert.rejects(
      readOwnerBookingDetail(session, locationId, bookingId, async () =>
        Response.json({}, { status }),
      ),
      (error: unknown) =>
        error instanceof BookingDetailReadError && error.reason === reason,
    );
  }
});
