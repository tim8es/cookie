import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import { IdentitySessions } from "../../../packages/platform-identity/src/index.js";
import {
  AuthorizationDeniedError,
  requireTenantPermission,
} from "../../../packages/platform-identity/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";
import { verifyTenantActor } from "../src/session-context.js";
import { createTenantSessionVerifier } from "../src/tenant-session-verifier.js";

test(
  "global Identity session is tenant-scoped by locked policy and serializes with revoke",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
    const identityId = randomUUID();
    const otherIdentityId = randomUUID();
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const roleId = randomUUID();
    const otherRoleId = randomUUID();
    const sessions = new IdentitySessions(
      pool,
      "identity-guard-test",
      "web",
      900,
    );
    let releaseCommand!: () => void;
    let signalAuthorized!: () => void;
    const commandGate = new Promise<void>((resolveGate) => {
      releaseCommand = resolveGate;
    });
    const authorized = new Promise<void>((resolveReady) => {
      signalAuthorized = resolveReady;
    });
    let command: Promise<void> | undefined;
    let revoking: Promise<void> | undefined;
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid),($2::uuid)",
        [identityId, otherIdentityId],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1::uuid,$2::uuid,'Synthetic A'),($3::uuid,$4::uuid,'Synthetic B')`,
        [tenantId, identityId, otherTenantId, otherIdentityId],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1::uuid,$2::uuid),($3::uuid,$4::uuid)",
        [tenantId, identityId, otherTenantId, otherIdentityId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions)
         VALUES($1::uuid,$2::uuid,'owner','Owner',ARRAY['organization.context.read']),
               ($3::uuid,$4::uuid,'owner','Owner',ARRAY['organization.context.read'])`,
        [tenantId, roleId, otherTenantId, otherRoleId],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid),($5::uuid,$6::uuid,$7::uuid,$8::uuid)`,
        [
          tenantId,
          randomUUID(),
          identityId,
          roleId,
          otherTenantId,
          randomUUID(),
          otherIdentityId,
          otherRoleId,
        ],
      );

      const session = await sessions.issueForVerifiedIdentity(identityId);
      const verifier = createTenantSessionVerifier(null, [sessions])!;
      const tenantActor = await verifyTenantActor(
        `Bearer ${session.token}`,
        tenantId,
        verifier,
      );
      assert.ok(tenantActor.actor);
      const otherTenantActor = await verifyTenantActor(
        `Bearer ${session.token}`,
        otherTenantId,
        verifier,
      );
      assert.ok(otherTenantActor.actor);

      await assert.rejects(
        runSqlTransaction(pool, (client) =>
          requireTenantPermission(
            client,
            otherTenantActor.actor!,
            { kind: "organization", tenantId: otherTenantId },
            "organization.context.read",
          ),
        ),
        AuthorizationDeniedError,
      );

      command = runSqlTransaction(pool, async (client) => {
        await requireTenantPermission(
          client,
          tenantActor.actor!,
          { kind: "organization", tenantId },
          "organization.context.read",
        );
        signalAuthorized();
        await commandGate;
      });
      await authorized;

      let revokeFinished = false;
      revoking = sessions.revoke(session.token).then(() => {
        revokeFinished = true;
      });
      const deadline = Date.now() + 3_000;
      let revokeBlocked = false;
      while (!revokeBlocked && Date.now() < deadline) {
        const state = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_stat_activity
             WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
               AND query ILIKE '%identity_sessions%'
           ) AS waiting`,
        );
        revokeBlocked = state.rows[0]?.waiting === true;
        if (!revokeBlocked) await new Promise((done) => setTimeout(done, 10));
      }
      assert.equal(
        revokeBlocked,
        true,
        "revocation should wait for the authorized transaction",
      );
      assert.equal(revokeFinished, false);

      releaseCommand();
      await command;
      await revoking;
      await assert.rejects(
        runSqlTransaction(pool, (client) =>
          requireTenantPermission(
            client,
            tenantActor.actor!,
            { kind: "organization", tenantId },
            "organization.context.read",
          ),
        ),
        AuthorizationDeniedError,
      );
    } finally {
      releaseCommand();
      await command?.catch(() => undefined);
      await revoking?.catch(() => undefined);
      await pool.query(
        "DELETE FROM cookie_identity.authorization_audit WHERE tenant_id IN ($1::uuid,$2::uuid)",
        [tenantId, otherTenantId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.auth_security_events WHERE identity_id IN ($1::uuid,$2::uuid)",
        [identityId, otherIdentityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.identity_sessions WHERE identity_id IN ($1::uuid,$2::uuid)",
        [identityId, otherIdentityId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.role_assignments WHERE tenant_id IN ($1::uuid,$2::uuid)",
        [tenantId, otherTenantId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.roles WHERE tenant_id IN ($1::uuid,$2::uuid)",
        [tenantId, otherTenantId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.memberships WHERE tenant_id IN ($1::uuid,$2::uuid)",
        [tenantId, otherTenantId],
      );
      await pool.query(
        "DELETE FROM cookie_tenancy.organizations WHERE id IN ($1::uuid,$2::uuid)",
        [tenantId, otherTenantId],
      );
      await pool.query(
        "DELETE FROM cookie_identity.identities WHERE id IN ($1::uuid,$2::uuid)",
        [identityId, otherIdentityId],
      );
      await pool.end();
    }
  },
);
