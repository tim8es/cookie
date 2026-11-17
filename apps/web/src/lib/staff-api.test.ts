import assert from "node:assert/strict";
import test from "node:test";

import { createRealStaff, readRealStaff, StaffApiFailure } from "./staff-api";
import type { VerifiedOwnerSession } from "./owner-auth";

const TENANT = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const LOCATION = "33333333-3333-4333-8333-333333333333";
const SERVICE = "44444444-4444-4444-8444-444444444444";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session: VerifiedOwnerSession = {
  tenantId: TENANT,
  accessToken: "cs_" + "A".repeat(43),
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 900,
};
const staff = {
  id: STAFF,
  displayName: "Synthetic Ada",
  positionTitle: "Stylist",
  active: true,
  bookable: false,
  createdAt: "2026-11-17T00:00:00.000Z",
  assignments: [{ locationId: LOCATION, serviceIds: [SERVICE] }],
};
const directory = {
  staff: [staff],
  locations: [{ id: LOCATION, displayName: "Studio" }],
};

function mock(
  response: Response,
  calls: Array<{ url: string; init: RequestInit }>,
): typeof fetch {
  return (async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return response;
  }) as typeof fetch;
}

test("staff query is bearer-scoped, no-store and validates location relationships", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await readRealStaff(
    session,
    mock(Response.json(directory), calls),
  );
  assert.deepEqual(result, directory);
  assert.equal(calls[0]?.url, "/v1/organizations/" + TENANT + "/staff");
  assert.equal(calls[0]?.init.cache, "no-store");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).authorization,
    "Bearer " + session.accessToken,
  );
});

test("staff create sends one stable replay key and only draft fields", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const draft = {
    displayName: "Synthetic Ada",
    positionTitle: "Stylist",
    locationId: LOCATION,
    serviceId: SERVICE,
  };
  const result = await createRealStaff(
    session,
    draft,
    KEY,
    mock(Response.json({ staff }, { status: 201 }), calls),
  );
  assert.deepEqual(result, staff);
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), draft);
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)["idempotency-key"],
    KEY,
  );
});

test("malformed or foreign staff directory never renders as success", async () => {
  for (const invalid of [
    { staff: [staff, staff], locations: directory.locations },
    { staff: [{ ...staff, bookable: "yes" }], locations: directory.locations },
    {
      staff: [
        {
          ...staff,
          assignments: [{ locationId: STAFF, serviceIds: [SERVICE] }],
        },
      ],
      locations: directory.locations,
    },
    {
      staff: [
        {
          ...staff,
          assignments: [
            { locationId: LOCATION, serviceIds: [SERVICE, SERVICE] },
          ],
        },
      ],
      locations: directory.locations,
    },
    { staff: [staff], locations: [] },
    { staff: "yes", locations: directory.locations },
  ]) {
    await assert.rejects(
      readRealStaff(session, mock(Response.json(invalid), [])),
      (reason: unknown) =>
        reason instanceof StaffApiFailure &&
        reason.reason === "invalid-response",
    );
  }
});

test("denied, unknown reference, conflict and offline staff write fail closed", async () => {
  const draft = {
    displayName: "Synthetic Ada",
    positionTitle: "Stylist",
    locationId: LOCATION,
    serviceId: SERVICE,
  };
  for (const [status, reason] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "missing-reference"],
    [409, "conflict"],
    [503, "unavailable"],
  ] as const) {
    await assert.rejects(
      createRealStaff(
        session,
        draft,
        KEY,
        mock(new Response(null, { status }), []),
      ),
      (error: unknown) =>
        error instanceof StaffApiFailure && error.reason === reason,
    );
  }
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  await assert.rejects(
    readRealStaff(session, offline),
    (error: unknown) =>
      error instanceof StaffApiFailure && error.reason === "unavailable",
  );
});

test("expired owner bearer stops staff requests before HTTP", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await assert.rejects(
    readRealStaff(
      { ...session, expiresAtUnixSeconds: 1 },
      mock(Response.json(directory), calls),
    ),
    (error: unknown) =>
      error instanceof StaffApiFailure && error.reason === "unauthorized",
  );
  assert.equal(calls.length, 0);
});

test("staff capacity differs from replay conflict", async () => {
  const draft = {
    displayName: "Synthetic Ada",
    positionTitle: "Stylist",
    locationId: LOCATION,
    serviceId: SERVICE,
  };
  const body = { error: "staff-capacity-reached" };
  const response = Response.json(body, { status: 409 });
  await assert.rejects(
    createRealStaff(session, draft, KEY, mock(response, [])),
    (error: unknown) =>
      error instanceof StaffApiFailure && error.reason === "capacity",
  );
});
