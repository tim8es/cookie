import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "policy row lock waits for authorized command COMMIT while other tenant proceeds",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-tenant-policy-locks",
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    const fixtures = Array.from({ length: 2 }, () => ({
      tenant: randomUUID(),
      owner: randomUUID(),
      role: randomUUID(),
      assignment: randomUUID(),
    }));
    const [first, second] = fixtures;
    assert.ok(first && second);
    let authorizedClient: PoolClient | undefined;
    let revoker: PoolClient | undefined;
    let authorizedTransaction = false;
    let revokeTransaction = false;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      for (const fixture of fixtures) {
        await pool.query(
          "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
          [fixture.owner],
        );
        await pool.query(
          `INSERT INTO cookie_tenancy.organizations
             (id,owner_identity_id,display_name)
           VALUES ($1::uuid,$2::uuid,'Synthetic policy locking QA')`,
          [fixture.tenant, fixture.owner],
        );
        await pool.query(
          `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
           VALUES ($1::uuid,$2::uuid)`,
          [fixture.tenant, fixture.owner],
        );
        await pool.query(
          `INSERT INTO cookie_identity.roles
             (tenant_id,id,base_type,display_name,permissions)
           VALUES ($1::uuid,$2::uuid,'owner','Synthetic policy owner',
                   ARRAY['organization.context.read'])`,
          [fixture.tenant, fixture.role],
        );
        await pool.query(
          `INSERT INTO cookie_identity.role_assignments
             (tenant_id,id,identity_id,role_id)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
          [fixture.tenant, fixture.assignment, fixture.owner, fixture.role],
        );
      }

      authorizedClient = await pool.connect();
      await authorizedClient.query("BEGIN");
      authorizedTransaction = true;
      await requireTenantPermission(
        authorizedClient,
        {
          tenantId: first.tenant,
          identityId: first.owner,
          correlationId: "synthetic-held-policy-lock",
        },
        { kind: "organization", tenantId: first.tenant },
        "organization.context.read",
      );

      revoker = await pool.connect();
      await revoker.query("BEGIN");
      revokeTransaction = true;
      await revoker.query("SET LOCAL lock_timeout='300ms'");
      await assert.rejects(
        revoker.query(
          `UPDATE cookie_identity.roles SET active=false
           WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [first.tenant, first.role],
        ),
        { code: "55P03" },
        "revocation must not commit while the authorized command holds a policy row",
      );
      await revoker.query("ROLLBACK");
      revokeTransaction = false;

      // A different tenant must not be blocked by first tenant's role locks.
      await pool.query(
        `UPDATE cookie_identity.roles SET active=false
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [second.tenant, second.role],
      );
      const independent = await pool.query<{ active: boolean }>(
        `SELECT active FROM cookie_identity.roles
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [second.tenant, second.role],
      );
      assert.equal(independent.rows[0]?.active, false);
      const current = await pool.query<{ active: boolean }>(
        `SELECT active FROM cookie_identity.roles
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [first.tenant, first.role],
      );
      assert.equal(current.rows[0]?.active, true);

      await authorizedClient.query("COMMIT");
      authorizedTransaction = false;
      await pool.query(
        `UPDATE cookie_identity.roles SET active=false
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [first.tenant, first.role],
      );

      const recheck = await pool.connect();
      try {
        await recheck.query("BEGIN");
        await assert.rejects(
          requireTenantPermission(
            recheck,
            {
              tenantId: first.tenant,
              identityId: first.owner,
              correlationId: "synthetic-after-revocation",
            },
            { kind: "organization", tenantId: first.tenant },
            "organization.context.read",
          ),
          { code: "ACCESS_DENIED" },
          "a subsequent command must read the committed deactivated role",
        );
      } finally {
        await recheck.query("ROLLBACK").catch(() => undefined);
        recheck.release();
      }
    } finally {
      if (revokeTransaction && revoker)
        await revoker.query("ROLLBACK").catch(() => undefined);
      if (authorizedTransaction && authorizedClient)
        await authorizedClient.query("ROLLBACK").catch(() => undefined);
      revoker?.release();
      authorizedClient?.release();
      for (const table of [
        "cookie_identity.authorization_audit",
        "cookie_identity.role_assignments",
        "cookie_identity.roles",
        "cookie_identity.memberships",
      ]) {
        await pool
          .query("DELETE FROM " + table + " WHERE tenant_id = ANY($1::uuid[])", [
            fixtures.map((fixture) => fixture.tenant),
          ])
          .catch(() => undefined);
      }
      await pool
        .query(
          `DELETE FROM cookie_tenancy.organizations
           WHERE id=ANY($1::uuid[])`,
          [fixtures.map((fixture) => fixture.tenant)],
        )
        .catch(() => undefined);
      await pool
        .query(
          `DELETE FROM cookie_identity.identities
           WHERE id=ANY($1::uuid[])`,
          [fixtures.map((fixture) => fixture.owner)],
        )
        .catch(() => undefined);
      await pool.end();
    }
  },
);
