import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/index.js";
import { createApp } from "../src/app.js";
import { createTenantSessionVerifier } from "../src/tenant-session-verifier.js";

const modes = ["role", "assignment", "location", "membership"] as const;
type WorkspaceBody = { locations: { locationId: string }[] };

for (const mode of modes) {
  test(
    `global workspace read serializes with ${mode} revocation`,
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 4,
        connectionTimeoutMillis: 5_000,
      });
      const tenant = randomUUID();
      const foreign = randomUUID();
      const identity = randomUUID();
      const foreignIdentity = randomUUID();
      const role = randomUUID();
      const assignment = randomUUID();
      const first = randomUUID();
      const second = randomUUID();
      const foreignLocation = randomUUID();
      const sessions = new IdentitySessions(pool, "workspace-qa", "web", 600);
      let signal!: () => void;
      let resume!: () => void;
      const selected = new Promise<void>((done) => {
        signal = done;
      });
      const gate = new Promise<void>((done) => {
        resume = done;
      });
      let intercept = true;
      const interceptedPool = {
        async connect(): Promise<PoolClient> {
          const client = await pool.connect();
          return new Proxy(client, {
            get(target, property) {
              if (property === "query") {
                return async (sql: string, params?: unknown[]) => {
                  const result = await target.query(sql, params);
                  if (
                    intercept &&
                    typeof sql === "string" &&
                    sql.includes(
                      "LEFT JOIN cookie_identity.role_assignments AS ra",
                    )
                  ) {
                    intercept = false;
                    signal();
                    await gate;
                  }
                  return result;
                };
              }
              if (property === "release") return target.release.bind(target);
              return Reflect.get(target, property, target);
            },
          });
        },
      } as Pool;
      const app = createApp(pool, {
        syntheticWorkspaceReads: {
          pool: interceptedPool,
          verifier: createTenantSessionVerifier(null, [sessions])!,
        },
      });
      const revoke = async (client: Pick<PoolClient, "query">) => {
        if (mode === "role") {
          return client.query(
            "UPDATE cookie_identity.roles SET active=false WHERE tenant_id=$1 AND id=$2",
            [tenant, role],
          );
        }
        if (mode === "assignment") {
          return client.query(
            "UPDATE cookie_identity.role_assignments SET active=false WHERE tenant_id=$1 AND id=$2",
            [tenant, assignment],
          );
        }
        if (mode === "location") {
          return client.query(
            "UPDATE cookie_identity.role_assignments SET location_id=$3 WHERE tenant_id=$1 AND id=$2",
            [tenant, assignment, second],
          );
        }
        return client.query(
          "UPDATE cookie_identity.memberships SET active=false WHERE tenant_id=$1 AND identity_id=$2",
          [tenant, identity],
        );
      };

      try {
        await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
        await pool.query(
          "INSERT INTO cookie_identity.identities(id) VALUES($1),($2)",
          [identity, foreignIdentity],
        );
        await pool.query(
          `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
           VALUES($1,$2,'QA own organization'),($3,$4,'QA foreign organization')`,
          [tenant, identity, foreign, foreignIdentity],
        );
        await pool.query(
          `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
           VALUES($1,$2,'QA original branch','UTC'),
                 ($1,$3,'QA replacement branch','UTC'),
                 ($4,$5,'QA foreign branch','UTC')`,
          [tenant, first, second, foreign, foreignLocation],
        );
        await pool.query(
          "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1,$2)",
          [tenant, identity],
        );
        await pool.query(
          `INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions)
           VALUES($1,$2,'admin','QA Admin',ARRAY['booking.read'])`,
          [tenant, role],
        );
        await pool.query(
          `INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id,location_id)
           VALUES($1,$2,$3,$4,$5)`,
          [tenant, assignment, identity, role, first],
        );
        const { token } = await sessions.issueForVerifiedIdentity(identity);
        const send = (target = tenant) =>
          app.inject({
            method: "GET",
            url: `/v1/organizations/${target}/workspace-context`,
            headers: { authorization: "Bearer " + token },
          });
        const read = send();
        await Promise.race([
          selected,
          read.then(() => {
            throw new Error("Workspace response bypassed policy SELECT");
          }),
        ]);

        // Read-first must hold the exact policy row until COMMIT.
        const writer = await pool.connect();
        try {
          await writer.query("BEGIN");
          await writer.query("SET LOCAL lock_timeout='250ms'");
          await assert.rejects(revoke(writer), { code: "55P03" });
        } finally {
          try {
            await writer.query("ROLLBACK");
          } finally {
            writer.release();
            resume();
          }
        }
        const before = await read;
        assert.equal(before.statusCode, 200, before.body);
        const beforeLocations = before.json<WorkspaceBody>().locations;
        const beforeIds = beforeLocations.map((item) => item.locationId);
        assert.deepEqual(beforeIds, [first]);

        // Revoke-first: another read must use committed policy, not old scope.
        assert.equal((await revoke(pool)).rowCount, 1);
        const after = await send();
        if (mode === "location") {
          assert.equal(after.statusCode, 200, after.body);
          const afterLocations = after.json<WorkspaceBody>().locations;
          const afterIds = afterLocations.map((item) => item.locationId);
          assert.deepEqual(afterIds, [second]);
        } else {
          assert.equal(after.statusCode, 403, after.body);
          assert.ok(!after.body.includes("QA own organization"));
        }
        assert.ok(!after.body.includes("QA original branch"));
        const denied = await send(foreign);
        assert.equal(denied.statusCode, 403, denied.body);
        assert.ok(!denied.body.includes("QA foreign organization"));
        assert.ok(!denied.body.includes("QA foreign branch"));
      } finally {
        resume();
        await app.close().catch(() => undefined);
        try {
          await pool.query(
            "DELETE FROM cookie_identity.auth_security_events WHERE identity_id IN ($1,$2)",
            [identity, foreignIdentity],
          );
          await pool.query(
            "DELETE FROM cookie_identity.identity_sessions WHERE identity_id IN ($1,$2)",
            [identity, foreignIdentity],
          );
          for (const table of [
            "cookie_identity.authorization_audit",
            "cookie_identity.role_assignments",
            "cookie_identity.roles",
            "cookie_identity.memberships",
            "cookie_tenancy.locations",
          ]) {
            const sql = `DELETE FROM ${table} WHERE tenant_id IN ($1,$2)`;
            await pool.query(sql, [tenant, foreign]);
          }
          await pool.query(
            "DELETE FROM cookie_tenancy.organizations WHERE id IN ($1,$2)",
            [tenant, foreign],
          );
          await pool.query(
            "DELETE FROM cookie_identity.identities WHERE id IN ($1,$2)",
            [identity, foreignIdentity],
          );
        } finally {
          await pool.end();
        }
      }
    },
  );
}
