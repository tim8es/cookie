import assert from "node:assert/strict";
import test from "node:test";

import type { VerifiedOwnerSession } from "./owner-auth";
import {
  WorkspaceOverviewFailure,
  readRealWorkspaceOverview,
} from "./workspace-overview-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LOCATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session: VerifiedOwnerSession = {
  tenantId: TENANT,
  accessToken: "cs_" + "B".repeat(43),
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 900,
};
const overview = {
  organization: { organizationId: TENANT, displayName: "Салон Cookie" },
  locations: [
    {
      locationId: LOCATION,
      displayName: "Центр",
      timeZone: "Europe/Moscow",
    },
  ],
};

function mock(
  response: Response,
  calls: Array<{ url: string; init: RequestInit }> = [],
): typeof fetch {
  return (async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return response;
  }) as typeof fetch;
}

test("overview is fetched with the verified tenant and private bearer", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const controller = new AbortController();
  const result = await readRealWorkspaceOverview(
    session,
    mock(Response.json(overview), calls),
    controller.signal,
  );
  assert.deepEqual(result, overview);
  assert.equal(calls[0]?.url, "/v1/organizations/" + TENANT + "/workspace-overview");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.equal(calls[0]?.init.cache, "no-store");
  assert.equal(calls[0]?.init.redirect, "error");
  assert.equal(calls[0]?.init.referrerPolicy, "no-referrer");
  assert.equal(calls[0]?.init.signal, controller.signal);
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).authorization,
    "Bearer " + session.accessToken,
  );
});

test("overview rejects another tenant or malformed location data", async () => {
  const location = overview.locations[0]!;
  const invalid = [
    { ...overview, organization: { ...overview.organization, organizationId: OTHER } },
    { ...overview, organization: { ...overview.organization, displayName: "" } },
    { ...overview, locations: [location, location] },
    { ...overview, locations: [{ ...location, locationId: "not-a-uuid" }] },
    { ...overview, locations: [{ ...location, timeZone: "Mars/Olympus" }] },
    { ...overview, locations: [{ ...location, displayName: "a".repeat(201) }] },
    { ...overview, locations: Array.from({ length: 101 }, () => location) },
    { ...overview, locations: null },
  ];
  for (const payload of invalid) {
    await assert.rejects(
      readRealWorkspaceOverview(session, mock(Response.json(payload))),
      (reason: unknown) =>
        reason instanceof WorkspaceOverviewFailure &&
        reason.reason === "invalid-response",
    );
  }
});

test("empty and legacy timezone-null workspaces remain accurate", async () => {
  const empty = { ...overview, locations: [] };
  assert.deepEqual(
    await readRealWorkspaceOverview(session, mock(Response.json(empty))),
    empty,
  );
  const legacy = {
    ...overview,
    locations: [{ ...overview.locations[0], timeZone: null }],
  };
  assert.deepEqual(
    await readRealWorkspaceOverview(session, mock(Response.json(legacy))),
    legacy,
  );
});

test("expired or invalid tenant session makes no request", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  for (const rejected of [
    { ...session, expiresAtUnixSeconds: 0 },
    { ...session, tenantId: "invalid" },
  ]) {
    await assert.rejects(
      readRealWorkspaceOverview(rejected, mock(Response.json(overview), calls)),
      (reason: unknown) =>
        reason instanceof WorkspaceOverviewFailure &&
        reason.reason === "unauthorized",
    );
  }
  assert.equal(calls.length, 0);
});

test("overview authorization, unavailable service and offline fail closed", async () => {
  for (const [status, expected] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "unavailable"],
    [503, "unavailable"],
  ] as const) {
    await assert.rejects(
      readRealWorkspaceOverview(session, mock(new Response(null, { status }))),
      (reason: unknown) =>
        reason instanceof WorkspaceOverviewFailure && reason.reason === expected,
    );
  }
  await assert.rejects(
    readRealWorkspaceOverview(
      session,
      mock(new Response("not json", { status: 200 })),
    ),
    (reason: unknown) =>
      reason instanceof WorkspaceOverviewFailure &&
      reason.reason === "invalid-response",
  );
  const offline: typeof fetch = async () => {
    throw new TypeError("offline");
  };
  await assert.rejects(
    readRealWorkspaceOverview(session, offline),
    (reason: unknown) =>
      reason instanceof WorkspaceOverviewFailure &&
      reason.reason === "unavailable",
  );
});
