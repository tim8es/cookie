import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { createApp } from "../src/app.js";
import {
  postgresTenantPolicyGuard,
  type VerifiedSession,
} from "../src/session-context.js";

test(
  "independent QA: Fastify protected session route enforces live PostgreSQL tenant policy",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-http-session-postgres",
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const sharedMember = randomUUID();
    const nonMember = randomUUID();
    const locationA = randomUUID();
    const roleA = randomUUID();
    const roleB = randomUUID();
    const assignmentA = randomUUID();
    const assignmentB = randomUUID();
    const tenants = [tenantA, tenantB];
    const expires = Math.floor(Date.now() / 1000) + 60 * 60;
    const sessions: Record<string, VerifiedSession> = {
      "qa-token-a": {
        identityId: sharedMember,
        tenantId: tenantA,
        expiresAtUnixSeconds: expires,
      },
      "qa-token-b": {
        identityId: sharedMember,
        tenantId: tenantB,
        expiresAtUnixSeconds: expires,
      },
      "qa-token-expired": {
        identityId: sharedMember,
        tenantId: tenantA,
        expiresAtUnixSeconds: 1,
      },
      "qa-token-malformed": {
        identityId: sharedMember,
        tenantId: "not-a-uuid",
        expiresAtUnixSeconds: expires,
      },
      "qa-token-not-member": {
        identityId: nonMember,
        tenantId: tenantA,
        expiresAtUnixSeconds: expires,
      },
    };
    let verificationCalls = 0;
    const app = createApp(pool, {
      sessionRoutes: {
        verifier: {
          async verifyBearerToken(token) {
            verificationCalls++;
            return sessions[token] ?? null;
          },
        },
        policy: postgresTenantPolicyGuard(pool),
      },
    });
    const route = (tenantId: string): string =>
      "/v1/organizations/" + tenantId + "/session-context";
    const send = (
      token: string,
      tenantId: string,
      extraHeaders: Record<string, string> = {},
    ) =>
      app.inject({
        method: "GET",
        url:
          route(tenantId) +
          "?tenantId=" +
          tenantB +
          "&identityId=" +
          ownerB,
        headers: {
          authorization: "Bearer " + token,
          "x-tenant-id": tenantB,
          "x-identity-id": ownerB,
          "x-correlation-id": "spoofed-correlation",
          ...extraHeaders,
        },
      });
    interface AuditRow {
      readonly actor: string;
      readonly permission: string;
      readonly allowed: boolean;
      readonly reason: string;
      readonly correlation: string;
    }
    const audits = async (tenantId: string): Promise<AuditRow[]> => {
      const result = await pool.query<AuditRow>(
        `SELECT actor_identity_id::text AS actor,
                permission,allowed,reason,correlation_id AS correlation
         FROM cookie_identity.authorization_audit
         WHERE tenant_id=$1::uuid ORDER BY id`,
        [tenantId],
      );
      return result.rows;
    };
    const verifyAudit = async (
      tenantId: string,
      reasons: readonly string[],
    ): Promise<void> => {
      const rows = await audits(tenantId);
      assert.deepEqual(
        rows.map((row) => row.reason),
        reasons,
      );
      assert.ok(
        rows.every(
          (row) =>
            row.permission === "organization.context.read" &&
            row.actor === sharedMember &&
            row.allowed === (row.reason === "granted") &&
            row.correlation !== "spoofed-correlation" &&
            /^[0-9a-f-]{36}$/.test(row.correlation),
        ),
      );
      assert.equal(
        new Set(rows.map((row) => row.correlation)).size,
        rows.length,
        "server creates a distinct correlation per authorized policy evaluation",
      );
    };

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        `INSERT INTO cookie_identity.identities(id)
         VALUES ($1::uuid),($2::uuid),($3::uuid),($4::uuid)`,
        [ownerA, ownerB, sharedMember, nonMember],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'QA HTTP Organization A'),
                ($2::uuid,$4::uuid,'QA HTTP Organization B')`,
        [tenantA, tenantB, ownerA, ownerB],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name)
         VALUES ($1::uuid,$2::uuid,'QA scoped branch')`,
        [tenantA, locationA],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$3::uuid),($2::uuid,$3::uuid)`,
        [tenantA, tenantB, sharedMember],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES
           ($1::uuid,$3::uuid,'admin','QA manager A',
            ARRAY['organization.context.read']),
           ($2::uuid,$4::uuid,'admin','QA manager B',
            ARRAY['organization.context.read'])`,
        [tenantA, tenantB, roleA, roleB],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id,location_id)
         VALUES
           ($1::uuid,$3::uuid,$5::uuid,$6::uuid,$7::uuid),
           ($2::uuid,$4::uuid,$5::uuid,$8::uuid,NULL)`,
        [
          tenantA,
          tenantB,
          assignmentA,
          assignmentB,
          sharedMember,
          roleA,
          locationA,
          roleB,
        ],
      );

      // Invalid/absent credentials never reach the real PostgreSQL policy.
      const missing = await app.inject({
        method: "GET",
        url: route(tenantA),
        headers: { "x-tenant-id": tenantA, "x-identity-id": sharedMember },
      });
      assert.equal(missing.statusCode, 401);
      assert.equal(verificationCalls, 0);
      const doubled = await app.inject({
        method: "GET",
        url: route(tenantA),
        headers: { authorization: "Bearer qa-token-a, Bearer qa-token-b" },
      });
      assert.equal(doubled.statusCode, 401);
      assert.equal(verificationCalls, 0);
      for (const token of [
        "qa-token-unknown",
        "qa-token-expired",
        "qa-token-malformed",
      ]) {
        const response = await send(token, tenantA);
        assert.equal(response.statusCode, 401, token);
        assert.deepEqual(response.json(), { error: "unauthorized" });
      }
      assert.equal((await audits(tenantA)).length, 0);
      assert.equal((await audits(tenantB)).length, 0);

      // One real identity belongs to two tenants, but the URL and spoofed
      // headers/query cannot override the server-verified tenant selector.
      const foreignPath = await send("qa-token-a", tenantB);
      assert.equal(foreignPath.statusCode, 403);
      assert.deepEqual(foreignPath.json(), { error: "forbidden" });
      assert.equal((await audits(tenantB)).length, 0);
      assert.equal((await audits(tenantA)).length, 0);

      // A branch-scoped role is intentionally insufficient for an
      // organization-wide resource. Its denial must be persisted.
      const scopeDenied = await send("qa-token-a", tenantA);
      assert.equal(scopeDenied.statusCode, 403);
      assert.deepEqual(scopeDenied.json(), { error: "forbidden" });
      await verifyAudit(tenantA, ["permission-denied"]);

      await pool.query(
        `UPDATE cookie_identity.role_assignments
         SET location_id=NULL WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantA, assignmentA],
      );
      const grantedA = await send("qa-token-a", tenantA);
      assert.equal(grantedA.statusCode, 200);
      assert.deepEqual(grantedA.json(), { tenantId: tenantA });
      await verifyAudit(tenantA, ["permission-denied", "granted"]);

      const grantedB = await send("qa-token-b", tenantB);
      assert.equal(grantedB.statusCode, 200);
      assert.deepEqual(grantedB.json(), { tenantId: tenantB });
      await verifyAudit(tenantB, ["granted"]);
      const reversedPath = await send("qa-token-b", tenantA);
      assert.equal(reversedPath.statusCode, 403);
      await verifyAudit(tenantA, ["permission-denied", "granted"]);

      // Revocations must be enforced by the next actual SQL policy read;
      // previously granted context is not sticky in server-side sessions.
      await pool.query(
        `UPDATE cookie_identity.memberships SET active=false
         WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenantA, sharedMember],
      );
      const revokedA = await send("qa-token-a", tenantA);
      assert.equal(revokedA.statusCode, 403);
      await verifyAudit(tenantA, [
        "permission-denied",
        "granted",
        "inactive-membership",
      ]);
      const stillGrantedB = await send("qa-token-b", tenantB);
      assert.equal(stillGrantedB.statusCode, 200);
      await verifyAudit(tenantB, ["granted", "granted"]);

      await pool.query(
        `UPDATE cookie_identity.memberships SET active=true
         WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenantA, sharedMember],
      );
      await pool.query(
        `UPDATE cookie_identity.roles SET active=false
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantA, roleA],
      );
      assert.equal((await send("qa-token-a", tenantA)).statusCode, 403);
      await pool.query(
        `UPDATE cookie_identity.roles SET active=true
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantA, roleA],
      );
      await pool.query(
        `UPDATE cookie_identity.role_assignments SET active=false
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantA, assignmentA],
      );
      assert.equal((await send("qa-token-a", tenantA)).statusCode, 403);
      await pool.query(
        `UPDATE cookie_identity.role_assignments SET active=true
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantA, assignmentA],
      );
      assert.equal((await send("qa-token-a", tenantA)).statusCode, 200);

      // Tenant B revocation cannot affect tenant A for the same person.
      await pool.query(
        `UPDATE cookie_identity.memberships SET active=false
         WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenantB, sharedMember],
      );
      assert.equal((await send("qa-token-b", tenantB)).statusCode, 403);
      assert.equal((await send("qa-token-a", tenantA)).statusCode, 200);

      // A cryptographically verified identity with no membership is denied
      // by PostgreSQL rather than being accepted through token possession.
      const neverMember = await send("qa-token-not-member", tenantA);
      assert.equal(neverMember.statusCode, 403);
      assert.deepEqual(neverMember.json(), { error: "forbidden" });

      const finalA = await audits(tenantA);
      const finalB = await audits(tenantB);
      assert.deepEqual(
        finalA.map((row) => row.reason),
        [
          "permission-denied",
          "granted",
          "inactive-membership",
          "permission-denied",
          "permission-denied",
          "granted",
          "granted",
          "inactive-membership",
        ],
      );
      assert.deepEqual(
        finalB.map((row) => row.reason),
        ["granted", "granted", "inactive-membership"],
      );
      assert.deepEqual(
        finalA.map((row) => row.actor),
        [
          sharedMember,
          sharedMember,
          sharedMember,
          sharedMember,
          sharedMember,
          sharedMember,
          sharedMember,
          nonMember,
        ],
      );
      await verifyAudit(tenantB, [
        "granted",
        "granted",
        "inactive-membership",
      ]);
      assert.ok(
        finalA.every(
          (row) =>
            row.permission === "organization.context.read" &&
            row.allowed === (row.reason === "granted") &&
            row.correlation !== "spoofed-correlation",
        ),
      );
      const allCorrelationIds = [
        ...finalA.map((row) => row.correlation),
        ...finalB.map((row) => row.correlation),
      ];
      assert.equal(new Set(allCorrelationIds).size, allCorrelationIds.length);

      // Main API still intentionally has no Booking HTTP mutation routes.
      // This test must not imply any CreateBooking HTTP idempotency proof.
      const booking = await app.inject({
        method: "POST",
        url: "/v1/bookings",
        headers: { authorization: "Bearer qa-token-a" },
        payload: { tenantId: tenantA, price: 1 },
      });
      assert.equal(booking.statusCode, 404);
    } finally {
      await app.close();
      try {
        await pool.query(
          `DELETE FROM cookie_identity.authorization_audit
           WHERE tenant_id=ANY($1::uuid[])`,
          [tenants],
        );
        await pool.query(
          `DELETE FROM cookie_identity.role_assignments
           WHERE tenant_id=ANY($1::uuid[])`,
          [tenants],
        );
        await pool.query(
          `DELETE FROM cookie_identity.roles
           WHERE tenant_id=ANY($1::uuid[])`,
          [tenants],
        );
        await pool.query(
          `DELETE FROM cookie_identity.memberships
           WHERE tenant_id=ANY($1::uuid[])`,
          [tenants],
        );
        await pool.query(
          `DELETE FROM cookie_tenancy.locations
           WHERE tenant_id=ANY($1::uuid[])`,
          [tenants],
        );
        await pool.query(
          `DELETE FROM cookie_tenancy.organizations
           WHERE id=ANY($1::uuid[])`,
          [tenants],
        );
        await pool.query(
          `DELETE FROM cookie_identity.identities
           WHERE id=ANY($1::uuid[])`,
          [[ownerA, ownerB, sharedMember, nonMember]],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
