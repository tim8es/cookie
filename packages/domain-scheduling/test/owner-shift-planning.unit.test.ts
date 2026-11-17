import assert from "node:assert/strict";
import test from "node:test";

import { resolveLocalMinute } from "../src/local-minute.js";
import { evaluateAuthorization } from "../../platform-identity/src/authorization.js";

test("branch-local minute conversion respects IANA offset and daylight saving", () => {
  assert.equal(
    resolveLocalMinute("2027-07-12T09:30", "Europe/Moscow"),
    "2027-07-12T06:30:00.000Z",
  );
  assert.equal(
    resolveLocalMinute("2027-07-12T09:30", "Europe/Berlin"),
    "2027-07-12T07:30:00.000Z",
  );
  assert.equal(
    resolveLocalMinute("2027-01-12T09:30", "Europe/Berlin"),
    "2027-01-12T08:30:00.000Z",
  );
  assert.equal(
    resolveLocalMinute("2027-07-12T09:30", "Asia/Kathmandu"),
    "2027-07-12T03:45:00.000Z",
  );
});

test("a missing or duplicated DST minute is not silently accepted", () => {
  assert.throws(() => resolveLocalMinute("2027-03-28T02:30", "Europe/Berlin"));
  assert.throws(() => resolveLocalMinute("2027-10-31T02:30", "Europe/Berlin"));
  assert.throws(() => resolveLocalMinute("2027-02-30T09:30", "Europe/Moscow"));
  assert.throws(() => resolveLocalMinute("2027-07-12T09:30", "Not/AZone"));
  assert.throws(() => resolveLocalMinute("2027-07-12T09:30Z", "Europe/Moscow"));
});

test("owner draft planning permission cannot be delegated via admin role", () => {
  const permission = "schedule.shift.plan.create";
  const resource = {
    kind: "schedule" as const,
    tenantId: "tenant",
    locationId: "branch",
    staffProfileId: "staff",
  };
  const actor = {
    identityId: "admin",
    tenantId: "tenant",
    correlationId: "request",
  };
  const snapshot = {
    ownerIdentityId: "owner",
    membership: {
      identityId: "admin",
      tenantId: "tenant",
      active: true,
      assignments: [
        {
          roleId: "role",
          scope: { kind: "organization" as const },
          active: true,
        },
      ],
    },
    roles: [
      {
        id: "role",
        tenantId: "tenant",
        baseType: "admin" as const,
        displayName: "Owner",
        active: true,
        permissions: [permission],
      },
    ],
  };
  assert.deepEqual(
    evaluateAuthorization({ actor, resource, permission }, snapshot),
    { allowed: false, reason: "owner-required" },
  );
});
