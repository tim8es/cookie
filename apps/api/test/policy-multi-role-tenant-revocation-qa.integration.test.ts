import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface TenantFixture {
  readonly tenant: string;
  readonly owner: string;
  readonly roles: readonly string[];
  readonly assignments: readonly string[];
}

test(
  "multi-role policy locks serialize revocation without locking another tenant",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-multirole-policy-tenant",
      max: 6,
      connectionTimeoutMillis: 5_000,
    });
    const identityId = randomUUID();
    const a: TenantFixture = {
      tenant: randomUUID(),
      owner: randomUUID(),
      roles: [randomUUID(), randomUUID()],
      assignments: [randomUUID(), randomUUID()],
    };
    const b: TenantFixture = {
      tenant: randomUUID(),
      owner: randomUUID(),
      roles: [randomUUID()],
      assignments: [randomUUID()],
    };
    const fixtures = [a, b];
    let held: PoolClient | undefined;
    let heldTransaction = false;

    async function assertAllowed(tenantId: string, allowed: boolean) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const guard = requireTenantPermission(
          client,
          {
            identityId,
            tenantId,
            correlationId: "synthetic-multi-role-policy-qa",
          },
          { kind: "organization", tenantId },
          "booking.create",
        );
        if (allowed) {
          await guard;
        } else {
          await assert.rejects(
            guard,
            (error: unknown) => error instanceof AuthorizationDeniedError,
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid),($3::uuid)",
        [identityId, a.owner, b.owner],
      );
      for (const fixture of fixtures) {
        await pool.query(
          "INSERT INTO cookie_tenancy.organizations " +
            "(id,owner_identity_id,display_name) " +
            "VALUES ($1::uuid,$2::uuid,'Synthetic multi-role policy QA')",
          [fixture.tenant, fixture.owner],
        );
        await pool.query(
          "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) " +
            "VALUES ($1::uuid,$2::uuid)",
          [fixture.tenant, identityId],
        );
        for (const [index, roleId] of fixture.roles.entries()) {
          await pool.query(
            "INSERT INTO cookie_identity.roles " +
              "(tenant_id,id,base_type,display_name,permissions) " +
              "VALUES ($1::uuid,$2::uuid,'admin','Synthetic admin',ARRAY['booking.create'])",
            [fixture.tenant, roleId],
          );
          await pool.query(
            "INSERT INTO cookie_identity.role_assignments " +
              "(tenant_id,id,identity_id,role_id) " +
              "VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
            [fixture.tenant, fixture.assignments[index], identityId, roleId],
          );
        }
      }
      await assertAllowed(a.tenant, true);
      await assertAllowed(b.tenant, true);

      // Keep both of tenant A's active grants protected through COMMIT.
      held = await pool.connect();
      await held.query("BEGIN");
      heldTransaction = true;
      await requireTenantPermission(
        held,
        {
          identityId,
          tenantId: a.tenant,
          correlationId: "synthetic-held-multi-role-policy",
        },
        { kind: "organization", tenantId: a.tenant },
        "booking.create",
      );

      // A concurrently removed grant cannot commit ahead of this command.
      const revoker = await pool.connect();
      try {
        await revoker.query("BEGIN");
        await revoker.query("SET LOCAL lock_timeout='350ms'");
        await assert.rejects(
          revoker.query(
            "UPDATE cookie_identity.role_assignments " +
              "SET active=false WHERE tenant_id=$1::uuid AND id=$2::uuid",
            [a.tenant, a.assignments[1]],
          ),
          { code: "55P03" },
          "revoke of a second active granting role must wait for policy COMMIT",
        );
        await revoker.query("ROLLBACK");
      } finally {
        revoker.release();
      }

      // The same member identity in a different tenant must not inherit A's
      // locks or permissions: B's revocation commits while A is held.
      const unrelated = await pool.connect();
      try {
        await unrelated.query("BEGIN");
        await unrelated.query("SET LOCAL lock_timeout='700ms'");
        await unrelated.query(
          "UPDATE cookie_identity.role_assignments " +
            "SET active=false WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [b.tenant, b.assignments[0]],
        );
        await unrelated.query("COMMIT");
      } catch (error) {
        await unrelated.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        unrelated.release();
      }
      await assertAllowed(b.tenant, false);

      await held.query("COMMIT");
      heldTransaction = false;
      held.release();
      held = undefined;

      // Role union is authoritative AFTER the first revoke commits. The
      // remaining role still grants; losing both must deny without escalation.
      await pool.query(
        "UPDATE cookie_identity.role_assignments " +
          "SET active=false WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [a.tenant, a.assignments[0]],
      );
      await assertAllowed(a.tenant, true);
      await pool.query(
        "UPDATE cookie_identity.role_assignments " +
          "SET active=false WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [a.tenant, a.assignments[1]],
      );
      await assertAllowed(a.tenant, false);

      // Restoring B cannot authorize A, despite sharing identityId.
      await pool.query(
        "UPDATE cookie_identity.role_assignments " +
          "SET active=true WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [b.tenant, b.assignments[0]],
      );
      await assertAllowed(b.tenant, true);
      await assertAllowed(a.tenant, false);
    } finally {
      if (held) {
        if (heldTransaction)
          await held.query("ROLLBACK").catch(() => undefined);
        held.release();
      }
      for (const fixture of fixtures) {
        for (const table of [
          "cookie_identity.authorization_audit",
          "cookie_identity.role_assignments",
          "cookie_identity.roles",
          "cookie_identity.memberships",
        ]) {
          await pool
            .query("DELETE FROM " + table + " WHERE tenant_id=$1::uuid", [
              fixture.tenant,
            ])
            .catch(() => undefined);
        }
        await pool
          .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [
            fixture.tenant,
          ])
          .catch(() => undefined);
      }
      await pool
        .query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [[identityId, a.owner, b.owner]],
        )
        .catch(() => undefined);
      await pool.end();
    }
  },
);
