import assert from "node:assert/strict";
import test from "node:test";

import {
  LocationApiFailure,
  createRealLocation,
  readRealLocations,
} from "./locations-api";
import type { VerifiedOwnerSession } from "./owner-auth";

const TENANT = "11111111-1111-4111-8111-111111111111";
const LOCATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session: VerifiedOwnerSession = {
  tenantId: TENANT,
  accessToken: "cs_" + "B".repeat(43),
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 900,
};
const branch = {
  id: LOCATION,
  displayName: "Центр",
  timeZone: "Europe/Moscow",
  createdAt: "2026-11-16T20:00:00.000Z",
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

test("Locations list is scoped to verified owner tenant with no cached credentials", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const locations = await readRealLocations(
    session,
    mock(Response.json({ locations: [branch] }), calls),
  );
  assert.deepEqual(locations, [branch]);
  assert.equal(calls[0]?.url, "/v1/organizations/" + TENANT + "/locations");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.equal(calls[0]?.init.cache, "no-store");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).authorization,
    "Bearer " + session.accessToken,
  );
});

test("Location create carries only name/zone and a durable retry key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const draft = { displayName: "Центр", timeZone: "Europe/Moscow" };
  const saved = await createRealLocation(
    session,
    draft,
    KEY,
    mock(Response.json({ location: branch }, { status: 201 }), calls),
  );
  assert.deepEqual(saved, branch);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), draft);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)["idempotency-key"],
    KEY,
  );
});

test("bad, duplicate, excessive or missing-zone Location DTO is never accepted", async () => {
  for (const payload of [
    { locations: [branch, branch] },
    { locations: [{ ...branch, id: "foreign" }] },
    { locations: [{ ...branch, displayName: "" }] },
    { locations: [{ ...branch, timeZone: "Mars/Olympus?" }] },
    { locations: [{ ...branch, createdAt: "not-a-date" }] },
    { locations: { status: "ok" } },
    { locations: Array.from({ length: 101 }, (_, index) => ({ ...branch, id: String(index) })) },
  ]) {
    await assert.rejects(
      readRealLocations(session, mock(Response.json(payload), [])),
      (reason: unknown) =>
        reason instanceof LocationApiFailure &&
        reason.reason === "invalid-response",
    );
  }
  await assert.rejects(
    createRealLocation(
      session,
      { displayName: "Центр", timeZone: "Europe/Moscow" },
      KEY,
      mock(Response.json({ location: { ...branch, timeZone: null } }), []),
    ),
    (reason: unknown) =>
      reason instanceof LocationApiFailure &&
      reason.reason === "invalid-response",
  );
});

test("Location errors 401/403/409/503/offline do not produce fake writes", async () => {
  const draft = { displayName: "Центр", timeZone: "Europe/Moscow" };
  for (const [status, expected] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [409, "conflict"],
    [503, "unavailable"],
  ] as const) {
    await assert.rejects(
      createRealLocation(
        session,
        draft,
        KEY,
        mock(new Response(null, { status }), []),
      ),
      (reason: unknown) =>
        reason instanceof LocationApiFailure && reason.reason === expected,
    );
  }
  await assert.rejects(
    createRealLocation(
      session,
      draft,
      KEY,
      mock(Response.json({ error: "location-limit" }, { status: 409 }), []),
    ),
    (reason: unknown) =>
      reason instanceof LocationApiFailure && reason.reason === "limit",
  );
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  await assert.rejects(
    readRealLocations(session, offline),
    (reason: unknown) =>
      reason instanceof LocationApiFailure && reason.reason === "unavailable",
  );
});

test("expired owner session fails Locations API without network requests", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await assert.rejects(
    readRealLocations(
      { ...session, expiresAtUnixSeconds: 1 },
      mock(Response.json({ locations: [branch] }), calls),
    ),
    (reason: unknown) =>
      reason instanceof LocationApiFailure && reason.reason === "unauthorized",
  );
  assert.equal(calls.length, 0);
});
