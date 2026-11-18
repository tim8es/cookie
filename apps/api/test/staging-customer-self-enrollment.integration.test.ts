import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";
import { createTenantSessionVerifier } from "../src/tenant-session-verifier.js";

test(
  "a live global Identity session can explicitly enroll as a tenant client once",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
    const ownerId = randomUUID();
    const clientId = randomUUID();
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const locationId = randomUUID();
    const otherLocationId = randomUUID();
    const grantId = randomUUID();
    const sessions = new IdentitySessions(
      pool,
      "customer-enrollment-test",
      "web",
      900,
    );
    const verifier = createTenantSessionVerifier(null, [sessions])!;
    const app = createApp(pool, {
      stagingPublicationRoutes: {
        pool,
        verifier,
        enabled: true,
        identitySessionProviders: [sessions],
      },
    });
    t.after(async () => {
      await app.close();
      await pool.query(
        "DELETE FROM cookie_identity.authorization_audit WHERE tenant_id IN ($1::uuid,$2::uuid)",
        [tenantId, otherTenantId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.auth_security_events WHERE identity_id IN ($1::uuid,$2::uuid)",
        [ownerId, clientId],
      );
      await pool.query(
        `WITH removed AS (
           DELETE FROM cookie_customers.staging_customer_identities
           WHERE tenant_id=$1::uuid AND identity_id=$2::uuid
           RETURNING customer_id
         )
         DELETE FROM cookie_customers.customers AS customer
         USING removed
         WHERE customer.tenant_id=$1::uuid AND customer.id=removed.customer_id`,
        [tenantId, clientId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.identity_sessions WHERE identity_id=$1::uuid",
        [clientId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.role_assignments WHERE tenant_id=$1::uuid",
        [tenantId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.roles WHERE tenant_id=$1::uuid",
        [tenantId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.memberships WHERE tenant_id=$1::uuid",
        [tenantId],
      );
      await pool.query(
        "DELETE FROM cookie_entitlement.staging_publication_grants WHERE tenant_id=$1::uuid",
        [tenantId],
      );
      await pool.query(
        "DELETE FROM cookie_tenancy.locations WHERE tenant_id IN ($1::uuid,$2::uuid)",
        [tenantId, otherTenantId],
      );
      await pool.query(
        "DELETE FROM cookie_tenancy.organizations WHERE id IN ($1::uuid,$2::uuid)",
        [tenantId, otherTenantId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.identities WHERE id IN ($1::uuid,$2::uuid)",
        [ownerId, clientId],
      );
      await pool.end();
    });

    await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
    await pool.query(
      "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid),($2::uuid)",
      [ownerId, clientId],
    );
    await pool.query(
      "INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name) VALUES($1::uuid,$2::uuid,'Synthetic salon'),($3::uuid,$2::uuid,'Other synthetic salon')",
      [tenantId, ownerId, otherTenantId],
    );
    await pool.query(
      "INSERT INTO cookie_tenancy.locations(id,tenant_id,display_name,time_zone) VALUES($1::uuid,$2::uuid,'Synthetic location','Europe/Moscow'),($3::uuid,$4::uuid,'Other location','Europe/Moscow')",
      [locationId, tenantId, otherLocationId, otherTenantId],
    );
    await pool.query(
      "INSERT INTO cookie_entitlement.staging_publication_grants(tenant_id,id,seat_limit,expires_at) VALUES($1::uuid,$2::uuid,5,clock_timestamp()+interval '1 hour')",
      [tenantId, grantId],
    );
    const session = await sessions.issueForVerifiedIdentity(clientId);
    const request = (consentConfirmed: boolean) =>
      app.inject({
        method: "POST",
        url: `/v1/organizations/${tenantId}/staging-customer/enroll`,
        headers: { authorization: `Bearer ${session.token}` },
        payload: { consentConfirmed },
      });

    assert.equal((await request(false)).statusCode, 400);
    const enrolled = await request(true);
    assert.equal(enrolled.statusCode, 200);
    const customerId = enrolled.json().customerId as string;
    assert.equal(enrolled.json().tenantId, tenantId);
    const replayed = await request(true);
    assert.equal(replayed.statusCode, 200);
    assert.equal(replayed.json().customerId, customerId);

    const relation = await pool.query<{
      telegram_link_id: string | null;
      consent_confirmed_at: Date | null;
    }>(
      "SELECT telegram_link_id::text,consent_confirmed_at FROM cookie_customers.staging_customer_identities WHERE tenant_id=$1::uuid AND identity_id=$2::uuid",
      [tenantId, clientId],
    );
    assert.equal(relation.rowCount, 1);
    assert.equal(relation.rows[0]?.telegram_link_id, null);
    assert.ok(relation.rows[0]?.consent_confirmed_at instanceof Date);

    const context = await app.inject({
      method: "GET",
      url: `/v1/organizations/${tenantId}/staging-customer-context`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(context.statusCode, 200);
    assert.equal(context.json().customerId, customerId);

    const foreignContext = await app.inject({
      method: "GET",
      url: `/v1/organizations/${otherTenantId}/staging-customer-context`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(foreignContext.statusCode, 403);

    await sessions.revoke(session.token);
    const revoked = await request(true);
    assert.equal(revoked.statusCode, 401);
  },
);
