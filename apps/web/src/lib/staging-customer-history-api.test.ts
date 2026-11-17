import assert from "node:assert/strict";
import { test } from "node:test";
import { readOwnBookings } from "./staging-customer-history-api";

const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  customerId: "22222222-2222-4222-8222-222222222222",
  accessToken: "synthetic-bearer",
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 600,
};
const row = {
  bookingId: "33333333-3333-4333-8333-333333333333",
  status: "Confirmed",
  startAt: "2028-12-14T10:00:00.000Z",
  endAt: "2028-12-14T11:00:00.000Z",
  priceKopecks: "125050",
  locationName: "Branch",
  serviceName: "Service",
  staffName: "Staff",
  timeZone: "Europe/Moscow",
};

test("own history uses exact bearer and no customer input", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    const root = "/v1/organizations/" + session.tenantId;
    assert.equal(url, root + "/staging-customer-history");
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    const authorization = new Headers(init?.headers).get("authorization");
    assert.equal(authorization, "Bearer " + session.accessToken);
    return Response.json({ bookings: [row], hasMore: false });
  };
  assert.deepEqual(await readOwnBookings(session, fetcher), {
    bookings: [row],
    hasMore: false,
  });
});

test("malformed history cannot be rendered", async () => {
  for (const bookings of [
    [{ ...row, status: "Pending" }],
    [{ ...row, priceKopecks: 125050 }],
    [{ ...row, customerId: session.customerId }],
    [{ ...row, endAt: row.startAt }],
    [{ ...row, timeZone: "bad-zone" }],
    [row, row],
  ]) {
    const fetcher = async () => Response.json({ bookings, hasMore: false });
    await assert.rejects(readOwnBookings(session, fetcher), /unavailable/);
  }
});

test("expired history access never reaches transport", async () => {
  const fetcher = async () => {
    throw new Error("must not fetch");
  };
  await assert.rejects(
    readOwnBookings({ ...session, expiresAtUnixSeconds: 0 }, fetcher),
    /unauthorized/,
  );
});
