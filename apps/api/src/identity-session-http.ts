import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import type { IdentitySessions } from "../../../packages/platform-identity/src/index.js";

import { clearMatchingBrowserSession, registerBrowserIdentitySession } from "./browser-identity-session.js";

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}

/** Provider-neutral logout for verified pre-tenant Identity sessions. */
export function registerIdentitySessionLogout(
  app: FastifyInstance,
  providers: readonly IdentitySessions[],
): void {
  if (providers.length === 0) throw new Error("Identity providers required");
  registerBrowserIdentitySession(app, providers);
  app.post("/v1/auth/identity/logout", async (request, reply) => {
    noStore(reply);
    const token = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    clearMatchingBrowserSession(request, reply, token);
    try {
      await Promise.all(providers.map((provider) => provider.revoke(token)));
      return reply.code(204).send();
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}

/** List the caller's current tenant roles without accepting an identity claim. */
export function registerIdentityOrganizations(
  app: FastifyInstance,
  pool: Pool,
  providers: readonly IdentitySessions[],
): void {
  app.get("/v1/auth/identity/organizations", async (request, reply) => {
    noStore(reply);
    reply.header("Vary", "Authorization");
    const token = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    if (Object.keys(request.query as object).length !== 0)
      return reply.code(400).send({ error: "INVALID_REQUEST" });

    let stage = "begin-transaction";
    try {
      const organizations = await runSqlTransaction(pool, async (client) => {
        let identityId: string | null = null;
        stage = "resolve-identity";
        for (const provider of providers) {
          identityId = await provider.resolve(token);
          if (identityId) break;
        }
        if (!identityId) return null;

        stage = "read-memberships";
        const memberships = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id::text FROM cookie_identity.memberships
           WHERE identity_id=$1::uuid AND active
           ORDER BY tenant_id FOR SHARE`,
          [identityId],
        );
        const tenantIds = memberships.rows.map((row) => row.tenant_id);
        stage = "read-role-assignments";
        const assignments = tenantIds.length
          ? await client.query<{
              tenant_id: string;
              role_id: string;
            }>(
              `SELECT tenant_id::text,role_id::text
               FROM cookie_identity.role_assignments
               WHERE identity_id=$1::uuid AND tenant_id=ANY($2::uuid[]) AND active
               ORDER BY tenant_id,id FOR SHARE`,
              [identityId, tenantIds],
            )
          : { rows: [] };
        const roleIds = [
          ...new Set(assignments.rows.map((row) => row.role_id)),
        ];
        stage = "read-roles";
        const roles =
          tenantIds.length && roleIds.length
            ? await client.query<{
                tenant_id: string;
                id: string;
                base_type: string;
              }>(
                `SELECT tenant_id::text,id::text,base_type
               FROM cookie_identity.roles
               WHERE tenant_id=ANY($1::uuid[]) AND id=ANY($2::uuid[]) AND active
               ORDER BY tenant_id,id FOR SHARE`,
                [tenantIds, roleIds],
              )
            : { rows: [] };
        stage = "read-organizations";
        const rows = tenantIds.length
          ? await client.query<{
              id: string;
              display_name: string;
            }>(
              `SELECT id::text,display_name FROM cookie_tenancy.organizations
               WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
              [tenantIds],
            )
          : { rows: [] };

        let verifiedIdentity: string | null = null;
        stage = "revalidate-identity";
        for (const provider of providers) {
          verifiedIdentity = await provider.resolveWithinTransaction(
            client,
            token,
          );
          if (verifiedIdentity) break;
        }
        if (verifiedIdentity !== identityId) return null;

        const roleMap = new Map<string, Set<string>>();
        for (const assignment of assignments.rows) {
          const role = roles.rows.find(
            (candidate) =>
              candidate.tenant_id === assignment.tenant_id &&
              candidate.id === assignment.role_id,
          );
          if (!role) continue;
          const list = roleMap.get(assignment.tenant_id) ?? new Set<string>();
          list.add(role.base_type);
          roleMap.set(assignment.tenant_id, list);
        }
        return rows.rows.flatMap((row) => {
          const roleTypes = roleMap.get(row.id);
          return roleTypes
            ? [
                {
                  tenantId: row.id,
                  organizationName: row.display_name,
                  roleTypes: [...roleTypes].sort(),
                },
              ]
            : [];
        });
      });
      if (!organizations)
        return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return reply.send({ organizations });
    } catch (reason) {
      const code =
        typeof reason === "object" &&
        reason !== null &&
        "code" in reason &&
        typeof reason.code === "string" &&
        /^[A-Z0-9_]{1,32}$/.test(reason.code)
          ? reason.code
          : undefined;
      const diagnostic =
        reason instanceof Error && /timeout/i.test(reason.message)
          ? "timeout"
          : undefined;
      request.log.warn(
        { stage, code, diagnostic },
        "Identity organizations lookup failed",
      );
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}

/** Provider state is exposed only to the Identity behind the live bearer. */
export function registerIdentityProviders(
  app: FastifyInstance,
  pool: Pool,
  providers: readonly IdentitySessions[],
): void {
  app.get("/v1/auth/identity/providers", async (request, reply) => {
    noStore(reply);
    reply.header("Vary", "Authorization");
    const token = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    if (Object.keys(request.query as object).length !== 0)
      return reply.code(400).send({ error: "INVALID_REQUEST" });

    try {
      const state = await runSqlTransaction(pool, async (client) => {
        let identityId: string | null = null;
        for (const provider of providers) {
          identityId = await provider.resolveWithinTransaction(client, token);
          if (identityId) break;
        }
        if (!identityId) return null;
        const result = await client.query<{
          email: boolean;
          telegram: boolean;
        }>(
          `SELECT
             EXISTS(SELECT 1 FROM cookie_identity.email_credentials
                    WHERE identity_id=$1::uuid) AS email,
             EXISTS(SELECT 1 FROM cookie_identity.global_telegram_identities
                    WHERE identity_id=$1::uuid) AS telegram`,
          [identityId],
        );
        return result.rows[0] ?? null;
      });
      if (!state) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return reply.send({ providers: state });
    } catch {
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}
