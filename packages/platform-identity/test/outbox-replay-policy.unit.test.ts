import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { PoolClient } from "pg";

import { authorizeOutboxReplay } from "../src/index.js";
import type { TrustedActor } from "../src/authorization.js";

function policyFixture(options: { owner: boolean; membership?: boolean }) {
  const tenantId = randomUUID();
  const ownerIdentityId = randomUUID();
  const actor: TrustedActor = {
    tenantId,
    identityId: options.owner ? ownerIdentityId : randomUUID(),
    correlationId: "synthetic-outbox-port-test",
  };
  const calls: { sql: string; parameters: unknown[] }[] = [];
  const client = {
    async query(sql: string, parameters: unknown[] = []) {
      calls.push({ sql, parameters });
      if (sql.includes("FROM cookie_tenancy.organizations AS org")) {
        return {
          rows: [
            {
              owner_identity_id: ownerIdentityId,
              membership_identity_id:
                options.membership === false ? null : actor.identityId,
              membership_active: options.membership !== false,
              assignment_id: options.membership === false ? null : randomUUID(),
              assignment_active: options.membership !== false,
              assignment_location_id: null,
              role_id: options.membership === false ? null : randomUUID(),
              role_base_type: options.membership === false ? null : "owner",
              role_display_name: options.membership === false ? null : "Owner",
              role_permissions:
                options.membership === false ? null : ["outbox.replay"],
              role_active: options.membership !== false,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO cookie_identity.authorization_audit")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error("Unexpected query from outbox replay authorization");
    },
  } as unknown as PoolClient;
  return { client, actor, calls };
}

test("public Identity replay port authorizes the trusted owner and audits preflight", async () => {
  const { client, actor, calls } = policyFixture({ owner: true });
  await authorizeOutboxReplay(client, actor);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.sql, /cookie_identity\.memberships/);
  assert.deepEqual(calls[0]!.parameters, [
    actor.tenantId,
    actor.identityId,
  ]);
  assert.deepEqual(calls[1]!.parameters, [
    actor.tenantId,
    actor.identityId,
    actor.correlationId,
    null,
    "outbox.replay",
    true,
    "granted",
  ]);
});

test("public replay port denies delegated Owner role and audits denial", async () => {
  const { client, actor, calls } = policyFixture({ owner: false });
  await assert.rejects(authorizeOutboxReplay(client, actor), {
    name: "AuthorizationDeniedError",
    code: "ACCESS_DENIED",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.parameters.slice(-3), [
    false,
    "owner-required",
  ].slice(-3));
});

test("public replay port denies absent membership without replay mutation", async () => {
  const { client, actor, calls } = policyFixture({
    owner: true,
    membership: false,
  });
  await assert.rejects(authorizeOutboxReplay(client, actor), {
    name: "AuthorizationDeniedError",
    code: "ACCESS_DENIED",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.parameters.slice(-2), [
    false,
    "inactive-membership",
  ]);
});
