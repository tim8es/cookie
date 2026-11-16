import assert from "node:assert/strict";
import test from "node:test";

import { ServiceApiFailure, createRealService, readRealServices } from "./services-api";
import type { VerifiedOwnerSession } from "./owner-auth";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SERVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session: VerifiedOwnerSession = {
  tenantId: TENANT,
  accessToken: "cs_" + "A".repeat(43),
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 900,
};
const record = {
  id: SERVICE,
  displayName: "Synthetic haircut",
  durationMinutes: 60,
  basePriceKopecks: 150000,
  active: false,
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

test("real catalog list reads only bearer tenant and validates server receipt", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const services = await readRealServices(
    session, mock(Response.json({ services: [record] }), calls),
  );
  assert.deepEqual(services, [record]);
  assert.equal(calls[0]?.url, "/v1/organizations/" + TENANT + "/services");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.equal(calls[0]?.init.cache, "no-store");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).authorization,
    "Bearer " + session.accessToken,
  );
});

test("draft service creation includes an explicit stable replay key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const draft = {
    displayName: "Synthetic haircut",
    durationMinutes: 60,
    basePriceKopecks: 150000,
  };
  const returned = await createRealService(
    session, draft, KEY,
    mock(Response.json({ service: record }, { status: 201 }), calls),
  );
  assert.deepEqual(returned, record);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), draft);
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)["idempotency-key"],
    KEY,
  );
  assert.equal(calls[0]?.init.method, "POST");
});

test("malformed, foreign, oversize or non-json catalog receipts fail closed", async () => {
  const cases = [
    { services: [record, record] },
    { services: [{ ...record, basePriceKopecks: 12.25 }] },
    { services: [{ ...record, id: "foreign" }] },
    { services: { success: true } },
    { services: [{ ...record, createdAt: "not-an-instant" }] },
  ];
  for (const body of cases) {
    await assert.rejects(
      readRealServices(session, mock(Response.json(body), [])),
      (reason: unknown) =>
        reason instanceof ServiceApiFailure && reason.reason === "invalid-response",
    );
  }
});

test("401/403/409/503 and offline cannot become successful mutations", async () => {
  const draft = {
    displayName: "Synthetic haircut",
    durationMinutes: 60,
    basePriceKopecks: 150000,
  };
  for (const [status, expected] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [409, "conflict"],
    [503, "unavailable"],
  ] as const) {
    await assert.rejects(
      createRealService(
        session, draft, KEY,
        mock(new Response(null, { status }), []),
      ),
      (reason: unknown) =>
        reason instanceof ServiceApiFailure && reason.reason === expected,
    );
  }
  const broken = (async () => { throw new TypeError("offline"); }) as typeof fetch;
  await assert.rejects(
    readRealServices(session, broken),
    (reason: unknown) =>
      reason instanceof ServiceApiFailure && reason.reason === "unavailable",
  );
});

test("expired credential fails before network and never uses mock data", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await assert.rejects(
    readRealServices(
      { ...session, expiresAtUnixSeconds: 1 },
      mock(Response.json({ services: [record] }), calls),
    ),
    (reason: unknown) =>
      reason instanceof ServiceApiFailure && reason.reason === "unauthorized",
  );
  assert.equal(calls.length, 0);
});
