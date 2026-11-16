import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { evaluateAuthorization } from "../../../packages/platform-identity/src/authorization.js";
import { loadPolicySnapshot } from "../../../packages/platform-identity/src/postgres.js";
import {
  OwnerWorkspaceProvisionError,
  provisionOwnerWorkspace,
} from "../../../packages/platform-identity/src/provision-owner-workspace.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "real PostgreSQL owner provisioning is atomic, independently scoped and exactly replayable",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-owner-workspace-provision-qa",
      max: 5,
    });
    const owner = randomUUID();
    const secondOwner = randomUUID();
    const request = {
      ownerIdentityId: owner,
      idempotencyKey: "owner-first-" + randomUUID(),
      organizationName: "  Studio Cookie  ",
      locationName: "  Центр  ",
      timeZone: "Europe/Moscow",
    };
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid)",
        [owner, secondOwner],
      );

      // Two callers with the same verified identity and key race on separate PG
      // connections. Identity row FOR UPDATE serializes them to one commit.
      const [first, second] = await Promise.all([
        provisionOwnerWorkspace(pool, request),
        provisionOwnerWorkspace(pool, request),
      ]);
      assert.equal(first.tenantId, second.tenantId);
      assert.equal(first.locationId, second.locationId);
      assert.equal(first.roleId, second.roleId);
      assert.equal(first.assignmentId, second.assignmentId);
      assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);

      const result = await pool.query<{
        tenant_id: string;
        owner_identity_id: string;
        organization_name: string;
        location_name: string;
        time_zone: string;
        role_base_type: string;
        role_location_id: string | null;
        receipt_count: string;
      }>(
        `SELECT org.id::text AS tenant_id, org.owner_identity_id::text,
                org.display_name AS organization_name,
                loc.display_name AS location_name, loc.time_zone,
                role.base_type AS role_base_type,
                assignment.location_id::text AS role_location_id,
                (SELECT count(*)::text FROM cookie_tenancy.owner_setup_receipts
                   WHERE owner_identity_id=$1::uuid) AS receipt_count
           FROM cookie_tenancy.organizations org
           JOIN cookie_tenancy.locations loc ON loc.tenant_id=org.id
           JOIN cookie_identity.memberships mem
             ON mem.tenant_id=org.id AND mem.identity_id=org.owner_identity_id AND mem.active
           JOIN cookie_identity.role_assignments assignment
             ON assignment.tenant_id=org.id AND assignment.identity_id=mem.identity_id
                AND assignment.active
           JOIN cookie_identity.roles role
             ON role.tenant_id=org.id AND role.id=assignment.role_id AND role.active
          WHERE org.id=$2::uuid`,
        [owner, first.tenantId],
      );
      assert.equal(result.rows.length, 1);
      assert.deepEqual(result.rows[0], {
        tenant_id: first.tenantId,
        owner_identity_id: owner,
        organization_name: "Studio Cookie",
        location_name: "Центр",
        time_zone: "Europe/Moscow",
        role_base_type: "owner",
        role_location_id: null,
        receipt_count: "1",
      });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const actor = {
          identityId: owner,
          tenantId: first.tenantId,
          correlationId: "owner-provision-integration",
        };
        const snapshot = await loadPolicySnapshot(client, actor);
        assert.equal(
          evaluateAuthorization(
            {
              actor,
              resource: {
                kind: "organization",
                tenantId: first.tenantId,
                locationId: first.locationId,
              },
              permission: "booking.create",
            },
            snapshot,
          ).allowed,
          true,
        );
        assert.equal(
          evaluateAuthorization(
            {
              actor: { ...actor, identityId: secondOwner },
              resource: { kind: "organization", tenantId: first.tenantId },
              permission: "organization.transfer-owner",
              ownerProtected: true,
            },
            snapshot,
          ).allowed,
          false,
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      await assert.rejects(
        provisionOwnerWorkspace(pool, {
          ...request,
          organizationName: "Changed salon name",
        }),
        (error: unknown) =>
          error instanceof OwnerWorkspaceProvisionError &&
          error.code === "IDEMPOTENCY_KEY_REUSED",
      );
      await assert.rejects(
        provisionOwnerWorkspace(pool, {
          ...request,
          idempotencyKey: "bad-time-zone-" + randomUUID(),
          timeZone: "Invalid/Fake_Timezone",
        }),
        (error: unknown) =>
          error instanceof OwnerWorkspaceProvisionError &&
          error.code === "INVALID_INPUT",
      );
      await assert.rejects(
        provisionOwnerWorkspace(pool, {
          ...request,
          ownerIdentityId: randomUUID(),
          idempotencyKey: "missing-identity-" + randomUUID(),
        }),
        (error: unknown) =>
          error instanceof OwnerWorkspaceProvisionError &&
          error.code === "IDENTITY_NOT_FOUND",
      );

      const otherTenant = await provisionOwnerWorkspace(pool, {
        ...request,
        ownerIdentityId: secondOwner,
      });
      assert.notEqual(otherTenant.tenantId, first.tenantId);

      const createdAgain = await provisionOwnerWorkspace(pool, {
        ...request,
        idempotencyKey: "another-business-" + randomUUID(),
      });
      assert.notEqual(createdAgain.tenantId, first.tenantId);

      const receiptCount = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM cookie_tenancy.owner_setup_receipts WHERE owner_identity_id=$1::uuid",
        [owner],
      );
      assert.equal(receiptCount.rows[0]?.count, "2");
    } finally {
      await pool.end();
    }
  },
);
