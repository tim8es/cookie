import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";

test(
  "owner workspace enrollment derives the owner from a live Identity session and is idempotent",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 3,
    });
    const identityId = randomUUID();
    const sessions = new IdentitySessions(
      pool,
      "owner-enrollment-test",
      "web",
      900,
    );
    const app = createApp(pool, {
      identitySessionProviders: [sessions],
      identitySessionPool: pool,
      ownerWorkspaceEnrollment: {
        pool,
        identitySessionProviders: [sessions],
      },
    });
    t.after(async () => {
      await app.close();
      await pool.query(
        "DELETE FROM cookie_tenancy.owner_setup_receipts WHERE owner_identity_id=$1::uuid",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.auth_security_events WHERE identity_id=$1::uuid",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.role_assignments WHERE identity_id=$1::uuid",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.roles WHERE tenant_id IN (SELECT id FROM cookie_tenancy.organizations WHERE owner_identity_id=$1::uuid)",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.memberships WHERE identity_id=$1::uuid",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_tenancy.locations WHERE tenant_id IN (SELECT id FROM cookie_tenancy.organizations WHERE owner_identity_id=$1::uuid)",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_tenancy.organizations WHERE owner_identity_id=$1::uuid",
        [identityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
        [identityId],
      );
      await pool.end();
    });

    await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
    await pool.query(
      "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
      [identityId],
    );
    const session = await sessions.issueForVerifiedIdentity(identityId);
    const request = (
      idempotencyKey: string,
      organizationName = "Synthetic salon",
    ) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/owner/workspace",
        headers: {
          authorization: `Bearer ${session.token}`,
          "idempotency-key": idempotencyKey,
        },
        payload: {
          organizationName,
          locationName: "Synthetic location",
          timeZone: "Europe/Moscow",
        },
      });

    const created = await request("owner-setup-00000001");
    assert.equal(created.statusCode, 201);
    const createdBody = created.json();
    assert.equal(typeof createdBody.tenantId, "string");
    assert.equal(typeof createdBody.locationId, "string");
    assert.equal(createdBody.replayed, false);
    assert.equal("ownerIdentityId" in createdBody, false);
    const organizationsResponse = await app.inject({
      method: "GET",
      url: "/v1/auth/identity/organizations",
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(organizationsResponse.statusCode, 200);
    assert.deepEqual(organizationsResponse.json().organizations, [
      {
        tenantId: createdBody.tenantId,
        organizationName: "Synthetic salon",
        roleTypes: ["owner"],
      },
    ]);
    const replayed = await request("owner-setup-00000001");
    assert.equal(replayed.statusCode, 200);
    assert.equal(replayed.json().tenantId, createdBody.tenantId);
    assert.equal(replayed.json().replayed, true);
    assert.equal(
      (await request("owner-setup-00000001", "Changed salon")).statusCode,
      409,
    );

    await sessions.revoke(session.token);
    const revoked = await request("owner-setup-00000002");
    assert.equal(revoked.statusCode, 401);
    const organizationRows = await pool.query(
      "SELECT id FROM cookie_tenancy.organizations WHERE owner_identity_id=$1::uuid",
      [identityId],
    );
    assert.equal(organizationRows.rowCount, 1);
  },
);
