import assert from "node:assert/strict";
import test from "node:test";

import {
  StaffApiFailure,
  createRealStaff,
  readRealStaff,
} from "./staff-api";
import type { VerifiedOwnerSession } from "./owner-auth";

const TENANT = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session: VerifiedOwnerSession = {
  tenantId: TENANT,
  accessToken: "cs_" + "B".repeat(43),
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 900,
};
const saved = {
  id: STAFF_ID,
  displayName: "Алекс Тест",
  positionTitle: "Мастер",
  active: true,
  bookable: false,
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

test("real Staff API reads only owner tenant through in-memory bearer", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const staff = await readRealStaff(
    session,
    mock(Response.json({ staff: [saved] }), calls),
  );
  assert.deepEqual(staff, [saved]);
  assert.equal(calls[0]?.url, "/v1/organizations/" + TENANT + "/staff");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.equal(calls[0]?.init.cache, "no-store");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).authorization,
    "Bearer " + session.accessToken,
  );
});

test("creating a real Staff draft sends only name/title and stable replay key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const draft = { displayName: "Алекс Тест", positionTitle: "Мастер" };
  const result = await createRealStaff(
    session,
    draft,
    KEY,
    mock(Response.json({ staff: saved }, { status: 201 }), calls),
  );
  assert.deepEqual(result, saved);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), draft);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)["idempotency-key"],
    KEY,
  );
});

test("foreign/malformed/oversize/duplicate Staff receipts fail closed", async () => {
  for (const body of [
    { staff: [saved, saved] },
    { staff: [{ ...saved, id: "other-tenant" }] },
    { staff: [{ ...saved, bookable: true, active: false }] },
    { staff: [{ ...saved, displayName: "" }] },
    { staff: [{ ...saved, positionTitle: "x".repeat(101) }] },
    { staff: [{ ...saved, createdAt: "invalid" }] },
    { staff: { success: true } },
  ]) {
    await assert.rejects(
      readRealStaff(session, mock(Response.json(body), [])),
      (reason: unknown) =>
        reason instanceof StaffApiFailure &&
        reason.reason === "invalid-response",
    );
  }
  await assert.rejects(
    createRealStaff(
      session,
      { displayName: "Алекс Тест", positionTitle: "Мастер" },
      KEY,
      mock(Response.json({ staff: { ...saved, bookable: true } }), []),
    ),
    (reason: unknown) =>
      reason instanceof StaffApiFailure &&
      reason.reason === "invalid-response",
  );
});

test("401, 403, 409, 503 and offline cannot be represented as successful Staff save", async () => {
  const draft = { displayName: "Алекс Тест", positionTitle: "Мастер" };
  for (const [status, expected] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
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
      (reason: unknown) =>
        reason instanceof StaffApiFailure && reason.reason === expected,
    );
  }
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  await assert.rejects(
    readRealStaff(session, offline),
    (reason: unknown) =>
      reason instanceof StaffApiFailure &&
      reason.reason === "unavailable",
  );
});

test("expired Cookie owner credential fails before any Staff network request", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await assert.rejects(
    readRealStaff(
      { ...session, expiresAtUnixSeconds: 1 },
      mock(Response.json({ staff: [saved] }), calls),
    ),
    (reason: unknown) =>
      reason instanceof StaffApiFailure && reason.reason === "unauthorized",
  );
  assert.equal(calls.length, 0);
});
