import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeSensitive,
  evaluateAuthorization,
  type Membership,
  type OrganizationRole,
  type PolicySnapshot,
  type ProtectedResource,
  type TrustedActor,
} from "../src/authorization.js";

const alice: TrustedActor = {
  identityId: "alice",
  tenantId: "salon-a",
  correlationId: "trace-1",
};

const bookingA: ProtectedResource = {
  kind: "booking",
  tenantId: "salon-a",
  locationId: "branch-a",
  staffProfileId: "staff-a",
  clientIdentityId: "client-a",
};

function role(
  id: string,
  baseType: OrganizationRole["baseType"],
  permissions: readonly string[],
): OrganizationRole {
  return {
    id,
    tenantId: "salon-a",
    baseType,
    displayName: "Arbitrary title",
    permissions,
    active: true,
  };
}

function membership(
  assignments: Membership["assignments"],
  identityId = "alice",
): Membership {
  return {
    identityId,
    tenantId: "salon-a",
    active: true,
    assignments,
  };
}

function snapshot(
  member: Membership | null,
  roles: readonly OrganizationRole[],
  ownerIdentityId = "owner",
): PolicySnapshot {
  return { membership: member, roles, ownerIdentityId };
}

test("denies missing membership, malformed trusted context and foreign-tenant resources", () => {
  const admin = role("admin", "admin", ["booking.read"]);
  const assignment = { roleId: "admin", active: true, scope: { kind: "organization" } } as const;
  const policy = snapshot(membership([assignment]), [admin]);

  assert.deepEqual(
    evaluateAuthorization(
      { actor: alice, resource: bookingA, permission: "booking.read" },
      snapshot(null, [admin]),
    ),
    { allowed: false, reason: "inactive-membership" },
  );
  assert.deepEqual(
    evaluateAuthorization(
      {
        actor: alice,
        resource: { ...bookingA, tenantId: "salon-b" },
        permission: "booking.read",
      },
      policy,
    ),
    { allowed: false, reason: "foreign-tenant" },
  );
  assert.deepEqual(
    evaluateAuthorization(
      {
        actor: { ...alice, correlationId: "" },
        resource: bookingA,
        permission: "booking.read",
      },
      policy,
    ),
    { allowed: false, reason: "invalid-context" },
  );
});

test("multiple scoped roles combine only within the same branch", () => {
  const admin = role("admin", "admin", ["booking.read", "booking.edit"]);
  const staff = role("staff", "staff", ["booking.read"]);
  const policy = snapshot(
    membership([
      { roleId: "admin", active: true, scope: { kind: "locations", locationIds: ["branch-a"] } },
      {
        roleId: "staff",
        active: true,
        staffProfileId: "staff-a",
        scope: { kind: "locations", locationIds: ["branch-b"] },
      },
    ]),
    [admin, staff],
  );

  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: bookingA, permission: "booking.edit" },
      policy,
    ).allowed,
    true,
  );
  const bookingB = { ...bookingA, locationId: "branch-b", staffProfileId: "staff-a" };
  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: bookingB, permission: "booking.read" },
      policy,
    ).allowed,
    true,
  );
  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: bookingB, permission: "booking.edit" },
      policy,
    ).allowed,
    false,
  );
  assert.equal(
    evaluateAuthorization(
      {
        actor: alice,
        resource: { kind: "organization", tenantId: "salon-a" },
        permission: "booking.read",
      },
      policy,
    ).allowed,
    false,
    "two location-scoped roles must not become organization-wide",
  );
});

test("display names and inactive roles/assignments never confer permissions", () => {
  const admin = { ...role("admin", "staff", ["booking.read"]), displayName: "Owner" };
  const policy = snapshot(
    membership([{ roleId: "admin", active: false, scope: { kind: "organization" } }]),
    [admin],
  );
  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: bookingA, permission: "booking.read" },
      policy,
    ).allowed,
    false,
  );

  const activePolicy = snapshot(
    membership([
      { roleId: "admin", active: true, scope: { kind: "organization" } },
    ]),
    [admin],
  );
  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: { ...bookingA, staffProfileId: "another-staff" }, permission: "booking.read" },
      activePolicy,
    ).allowed,
    false,
    "displaying the title Owner does not remove staff relationship restrictions",
  );
});

test("staff access is limited to own booking-linked customers and explicitly granted fields", () => {
  const staff = role("staff", "staff", [
    "booking.read",
    "customer.basic.read",
    "customer.phone.read",
  ]);
  const policy = snapshot(
    membership([
      {
        roleId: "staff",
        active: true,
        staffProfileId: "staff-a",
        scope: { kind: "locations", locationIds: ["branch-a"] },
      },
    ]),
    [staff],
  );
  const customer: ProtectedResource = {
    kind: "customer",
    tenantId: "salon-a",
    locationId: "branch-a",
    linkedStaffProfileIds: ["staff-a"],
  };
  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: customer, permission: "customer.basic.read" },
      policy,
    ).allowed,
    true,
  );
  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: customer, permission: "customer.phone.read" },
      policy,
    ).allowed,
    true,
  );
  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: customer, permission: "customer.notes.read" },
      policy,
    ).allowed,
    false,
  );
  assert.equal(
    evaluateAuthorization(
      {
        actor: alice,
        resource: { ...customer, linkedStaffProfileIds: ["staff-b"] },
        permission: "customer.phone.read",
      },
      policy,
    ).allowed,
    false,
  );
  assert.equal(
    evaluateAuthorization(
      {
        actor: alice,
        resource: { ...customer, locationId: "branch-b" },
        permission: "customer.basic.read",
      },
      policy,
    ).allowed,
    false,
  );
  assert.equal(
    evaluateAuthorization(
      {
        actor: alice,
        resource: { ...bookingA, staffProfileId: "staff-b" },
        permission: "booking.read",
      },
      policy,
    ).allowed,
    false,
  );
});

test("client identity never gains another customer's bookings or CRM", () => {
  const client = role("client", "client", ["booking.read", "customer.basic.read"]);
  const policy = snapshot(
    membership(
      [{ roleId: "client", active: true, scope: { kind: "organization" } }],
      "client-a",
    ),
    [client],
  );
  const actor = { ...alice, identityId: "client-a" };
  assert.equal(
    evaluateAuthorization(
      { actor, resource: bookingA, permission: "booking.read" },
      policy,
    ).allowed,
    true,
  );
  assert.equal(
    evaluateAuthorization(
      {
        actor,
        resource: { ...bookingA, clientIdentityId: "another-client" },
        permission: "booking.read",
      },
      policy,
    ).allowed,
    false,
  );
  assert.equal(
    evaluateAuthorization(
      {
        actor,
        resource: {
          kind: "customer",
          tenantId: "salon-a",
          locationId: "branch-a",
          linkedStaffProfileIds: [],
        },
        permission: "customer.basic.read",
      },
      policy,
    ).allowed,
    false,
  );
});

test("owner-protected operations cannot be delegated by admin or renamed roles", () => {
  const customAdmin = role("admin", "admin", ["organization.transfer-owner"]);
  const fakeOwner = role("fake-owner", "owner", ["organization.transfer-owner"]);
  const assignments = [
    { roleId: "admin", active: true, scope: { kind: "organization" } },
    { roleId: "fake-owner", active: true, scope: { kind: "organization" } },
  ] as const;
  const policy = snapshot(membership(assignments), [customAdmin, fakeOwner]);
  const request = {
    actor: alice,
    resource: { kind: "organization", tenantId: "salon-a" } as const,
    permission: "organization.transfer-owner",
    ownerProtected: true,
  };
  assert.deepEqual(evaluateAuthorization(request, policy), {
    allowed: false,
    reason: "owner-required",
  });

  const ownerPolicy = snapshot(
    membership(
      [{ roleId: "fake-owner", active: true, scope: { kind: "organization" } }],
      "owner",
    ),
    [fakeOwner],
  );
  assert.equal(
    evaluateAuthorization(
      { ...request, actor: { ...alice, identityId: "owner" } },
      ownerPolicy,
    ).allowed,
    true,
  );
});

test("duplicate role configuration and revoked membership fail closed", () => {
  const admin = role("admin", "admin", ["booking.read"]);
  const policy = snapshot(
    membership([{ roleId: "admin", active: true, scope: { kind: "organization" } }]),
    [admin, { ...admin }],
  );
  assert.deepEqual(
    evaluateAuthorization(
      { actor: alice, resource: bookingA, permission: "booking.read" },
      policy,
    ),
    { allowed: false, reason: "invalid-role-config" },
  );

  const revoked = snapshot(
    { ...membership([{ roleId: "admin", active: true, scope: { kind: "organization" } }]), active: false },
    [admin],
  );
  assert.equal(
    evaluateAuthorization(
      { actor: alice, resource: bookingA, permission: "booking.read" },
      revoked,
    ).allowed,
    false,
  );
});

test("sensitive preflight audits decisions without logging customer details", async () => {
  const records: unknown[] = [];
  const audit = { append: async (event: unknown) => { records.push(event); } };
  const admin = role("admin", "admin", ["booking.edit"]);
  const policy = snapshot(
    membership([{ roleId: "admin", active: true, scope: { kind: "organization" } }]),
    [admin],
  );
  const request = { actor: alice, resource: bookingA, permission: "booking.edit" };
  const allowed = await authorizeSensitive(request, policy, audit);
  assert.equal(allowed.allowed, true);
  const denied = await authorizeSensitive(
    { ...request, permission: "customer.export-all" },
    policy,
    audit,
  );
  assert.equal(denied.allowed, false);
  assert.equal(records.length, 2);
  assert.deepEqual(Object.keys(records[0] as object).sort(), [
    "actorIdentityId",
    "allowed",
    "category",
    "correlationId",
    "locationId",
    "permission",
    "reason",
    "tenantId",
  ]);
  await assert.rejects(
    () =>
      authorizeSensitive(request, policy, {
        append: async () => { throw new Error("audit storage offline"); },
      }),
    /audit storage offline/,
    "audit failure must reject before command execution",
  );
});
