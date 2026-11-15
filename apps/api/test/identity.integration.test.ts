import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import {
  evaluateAuthorization,
  type ProtectedResource,
  type TrustedActor,
} from "../../../packages/platform-identity/src/authorization.js";
import {
  loadPolicySnapshot,
  requireTenantPermission,
} from "../../../packages/platform-identity/src/postgres.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ROLE_ADMIN_A = "33333333-3333-4333-8333-333333333333";
const LOCATION_A = "44444444-4444-4444-8444-444444444444";
const LOCATION_B = "55555555-5555-4555-8555-555555555555";
const LOCATION_FOREIGN = "66666666-6666-4666-8666-666666666666";
const ROLE_STAFF_A = "77777777-7777-4777-8777-777777777777";
const ROLE_ADMIN_B = "88888888-8888-4888-8888-888888888888";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOREIGN_OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASSIGNMENT_ADMIN_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ASSIGNMENT_STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ASSIGNMENT_ADMIN_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const actorA: TrustedActor = {
  identityId: ACTOR,
  tenantId: TENANT_A,
  correlationId: "integration-test",
};

function booking(tenantId: string, locationId: string): ProtectedResource {
  return {
    kind: "booking",
    tenantId,
    locationId,
    staffProfileId: "99999999-9999-4999-8999-999999999999",
  };
}

test(
  "PostgreSQL roles and assignments never cross tenant/location scope",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-identity-test",
      max: 2,
    });
    let client: PoolClient | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      client = await pool.connect();
      await client.query("BEGIN");

      await client.query(
        "INSERT INTO cookie_identity.identities (id) VALUES ($1), ($2), ($3)",
        [ACTOR, OWNER, FOREIGN_OWNER],
      );
      await client.query(
        "INSERT INTO cookie_tenancy.organizations (id, owner_identity_id, display_name) VALUES ($1,$2,'Synthetic A'),($3,$4,'Synthetic B')",
        [TENANT_A, OWNER, TENANT_B, FOREIGN_OWNER],
      );
      await client.query(
        "INSERT INTO cookie_tenancy.locations (id, tenant_id, display_name) VALUES ($1,$2,'A'),($3,$4,'B'),($5,$6,'Foreign')",
        [
          LOCATION_A,
          TENANT_A,
          LOCATION_B,
          TENANT_A,
          LOCATION_FOREIGN,
          TENANT_B,
        ],
      );
      await client.query(
        "INSERT INTO cookie_identity.memberships (tenant_id,identity_id) VALUES ($1,$2),($3,$2)",
        [TENANT_A, ACTOR, TENANT_B],
      );
      await client.query(
        "INSERT INTO cookie_identity.roles (tenant_id,id,base_type,display_name,permissions) VALUES ($1,$2,'admin','Owner',$3),($1,$4,'staff','Staff',$5),($6,$7,'admin','Admin',$8)",
        [
          TENANT_A,
          ROLE_ADMIN_A,
          ["booking.read", "booking.edit", "organization.transfer-owner"],
          ROLE_STAFF_A,
          ["booking.read"],
          TENANT_B,
          ROLE_ADMIN_B,
          ["booking.read"],
        ],
      );
      await client.query(
        "INSERT INTO cookie_identity.role_assignments (tenant_id,id,identity_id,role_id,location_id) VALUES ($1,$2,$3,$4,$5),($1,$6,$3,$7,$8),($9,$10,$3,$11,$12)",
        [
          TENANT_A,
          ASSIGNMENT_ADMIN_A,
          ACTOR,
          ROLE_ADMIN_A,
          LOCATION_A,
          ASSIGNMENT_STAFF_A,
          ROLE_STAFF_A,
          LOCATION_B,
          TENANT_B,
          ASSIGNMENT_ADMIN_B,
          ROLE_ADMIN_B,
          LOCATION_FOREIGN,
        ],
      );

      const snapshot = await loadPolicySnapshot(client, actorA);
      assert.equal(snapshot.ownerIdentityId, OWNER);
      assert.equal(snapshot.membership?.assignments.length, 2);
      assert.deepEqual(
        evaluateAuthorization(
          {
            actor: actorA,
            resource: booking(TENANT_A, LOCATION_A),
            permission: "booking.edit",
          },
          snapshot,
        ),
        { allowed: true, reason: "granted" },
      );
      assert.equal(
        evaluateAuthorization(
          {
            actor: actorA,
            resource: booking(TENANT_A, LOCATION_B),
            permission: "booking.edit",
          },
          snapshot,
        ).allowed,
        false,
        "admin from branch A must not leak into branch B",
      );
      assert.equal(
        evaluateAuthorization(
          {
            actor: actorA,
            resource: booking(TENANT_B, LOCATION_FOREIGN),
            permission: "booking.edit",
          },
          snapshot,
        ).allowed,
        false,
        "actor for tenant A cannot use a tenant B resource",
      );
      assert.equal(
        evaluateAuthorization(
          {
            actor: actorA,
            resource: { kind: "organization", tenantId: TENANT_A },
            permission: "organization.transfer-owner",
          },
          snapshot,
        ).allowed,
        false,
        "role display name Owner cannot grant protected operation",
      );

      const actorB = { ...actorA, tenantId: TENANT_B };
      const foreignSnapshot = await loadPolicySnapshot(client, actorB);
      assert.equal(foreignSnapshot.roles.length, 1);
      assert.equal(
        evaluateAuthorization(
          {
            actor: actorB,
            resource: booking(TENANT_B, LOCATION_FOREIGN),
            permission: "booking.read",
          },
          foreignSnapshot,
        ).allowed,
        true,
        "same global identity has separate permissions in the other tenant",
      );
      assert.equal(
        evaluateAuthorization(
          {
            actor: actorB,
            resource: booking(TENANT_A, LOCATION_A),
            permission: "booking.read",
          },
          foreignSnapshot,
        ).allowed,
        false,
      );

      // PostgreSQL must refuse cross-tenant role/location links even when
      // an internal programmer accidentally supplies inconsistent IDs.
      await client.query("SAVEPOINT invalid_assignment");
      await assert.rejects(
        client.query(
          "INSERT INTO cookie_identity.role_assignments (tenant_id,id,identity_id,role_id,location_id) VALUES ($1,$2,$3,$4,$5)",
          [
            TENANT_A,
            "12121212-1212-4212-8212-121212121212",
            ACTOR,
            ROLE_ADMIN_A,
            LOCATION_FOREIGN,
          ],
        ),
        { code: "23503" },
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_assignment");

      await requireTenantPermission(
        client,
        actorA,
        booking(TENANT_A, LOCATION_A),
        "booking.edit",
      );
      await assert.rejects(
        requireTenantPermission(
          client,
          actorA,
          booking(TENANT_A, LOCATION_B),
          "booking.edit",
        ),
        { code: "ACCESS_DENIED" },
      );

      const audited = await client.query<{
        allowed: boolean;
        reason: string;
        permission: string;
      }>(
        "SELECT allowed, reason, permission FROM cookie_identity.authorization_audit WHERE tenant_id=$1 ORDER BY id",
        [TENANT_A],
      );
      assert.deepEqual(audited.rows, [
        { allowed: true, reason: "granted", permission: "booking.edit" },
        {
          allowed: false,
          reason: "permission-denied",
          permission: "booking.edit",
        },
      ]);

      await client.query(
        "UPDATE cookie_identity.memberships SET active = false WHERE tenant_id = $1 AND identity_id = $2",
        [TENANT_A, ACTOR],
      );
      await assert.rejects(
        requireTenantPermission(
          client,
          actorA,
          booking(TENANT_A, LOCATION_A),
          "booking.edit",
        ),
        { code: "ACCESS_DENIED" },
        "revocation must take effect on the next policy evaluation",
      );
    } finally {
      if (client) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      await pool.end();
    }
  },
);
