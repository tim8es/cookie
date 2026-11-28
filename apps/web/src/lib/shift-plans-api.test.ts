import assert from "node:assert/strict";
import test from "node:test";

import type { VerifiedOwnerSession } from "./owner-auth";
import {
  readShiftPlans,
  createShiftPlan,
  ShiftPlanError,
  shiftPlanSaveIsUncertain,
} from "./shift-plans-api";
const TENANT = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const LOCATION = "33333333-3333-4333-8333-333333333333";
const SHIFT = "44444444-4444-4444-8444-444444444444";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session: VerifiedOwnerSession = {
  tenantId: TENANT,
  accessToken: "cs_" + "A".repeat(43),
  expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 900,
};
const plan = {
  shiftId: SHIFT,
  staffId: STAFF,
  locationId: LOCATION,
  startAt: "2027-07-12T06:00:00.000Z",
  endAt: "2027-07-12T15:00:00.000Z",
  active: false,
  revision: 0,
};
const draft = {
  staffId: STAFF,
  locationId: LOCATION,
  startLocal: "2027-07-12T09:00",
  endLocal: "2027-07-12T18:00",
};

test("staff planning equals a genuine server draft and sends civil time and replay key", async () => {
  const fetcher = (async (url: string, request: RequestInit) => {
    assert.equal(url, "/v1/organizations/" + TENANT + "/shift-plans");
    assert.equal(request.cache, "no-store");
    assert.equal(request.credentials, "omit");
    assert.equal(
      (request.headers as Record<string, string>).authorization,
      "Bearer " + session.accessToken,
    );
    if (request.method === "GET")
      return Response.json({ plans: [plan], hasMore: false });
    assert.deepEqual(JSON.parse(String(request.body)), draft);
    assert.equal(
      (request.headers as Record<string, string>)["idempotency-key"],
      KEY,
    );
    return Response.json({ plan }, { status: 201 });
  }) as typeof fetch;
  assert.deepEqual(await readShiftPlans(session, fetcher), {
    plans: [plan],
    hasMore: false,
  });
  assert.deepEqual(await createShiftPlan(session, draft, KEY, fetcher), plan);
});

test("published, foreign, duplicate or reversed shift receipts cannot show draft success", async () => {
  for (const invalid of [
    { ...plan, active: true },
    { ...plan, staffId: LOCATION },
    { ...plan, endAt: plan.startAt },
    { ...plan, startAt: "2027-07-12T06:00:00+03:00" },
  ]) {
    const fetcher = (async () =>
      Response.json({ plan: invalid }, { status: 201 })) as typeof fetch;
    await assert.rejects(
      createShiftPlan(session, draft, KEY, fetcher),
      (reason: unknown) =>
        reason instanceof ShiftPlanError &&
        reason.reason === "invalid-response",
    );
  }
  await assert.rejects(
    readShiftPlans(session, (async () =>
      Response.json({ plans: [plan, plan], hasMore: false })) as typeof fetch),
  );
});

test("denied or invalid local time never becomes a successful shift", async () => {
  for (const [status, error, reason] of [
    [401, "unauthorized", "unauthorized"],
    [403, "forbidden", "unauthorized"],
    [409, "target-unavailable", "target-unavailable"],
    [409, "idempotency-conflict", "conflict"],
    [422, "local-time-invalid", "invalid-time"],
    [503, "unavailable", "unavailable"],
  ] as const) {
    const fetcher = (async () =>
      Response.json({ error }, { status })) as typeof fetch;
    await assert.rejects(
      createShiftPlan(session, draft, KEY, fetcher),
      (failure: unknown) =>
        failure instanceof ShiftPlanError && failure.reason === reason,
    );
  }
});

test("ambiguous shift writes remain unresolved after subsequent rejections", () => {
  for (const reason of [
    "unauthorized",
    "target-unavailable",
    "invalid-time",
    "conflict",
  ] as const) {
    assert.equal(
      shiftPlanSaveIsUncertain(false, new ShiftPlanError(reason)),
      false,
    );
    assert.equal(shiftPlanSaveIsUncertain(true, new ShiftPlanError(reason)), true);
  }
  for (const error of [
    new ShiftPlanError("unavailable"),
    new ShiftPlanError("invalid-response"),
    new Error("network"),
  ]) {
    assert.equal(shiftPlanSaveIsUncertain(false, error), true);
    assert.equal(shiftPlanSaveIsUncertain(true, error), true);
  }
});
