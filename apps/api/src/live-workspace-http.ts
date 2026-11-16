import type { FastifyInstance } from "fastify";
import type { Pool, QueryResultRow } from "pg";

import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

/**
 * The first live, database-backed Workspace read endpoint. Unlike synthetic
 * workspace adapters, this is safe to register for verified Cookie sessions.
 * It exposes only tenant-scoped organization + branch configuration, no
 * customer/staff/booking data and no provisional booking action.
 */
export interface LiveWorkspaceReadDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

interface OrganizationRow extends QueryResultRow {
  readonly display_name: string;
}

interface LocationRow extends QueryResultRow {
  readonly id: string;
  readonly display_name: string;
  readonly time_zone: string | null;
}

const MAX_LOCATIONS = 100;

export function registerLiveWorkspaceRead(
  app: FastifyInstance,
  dependencies: LiveWorkspaceReadDependencies,
): void {
  const { pool, verifier } = dependencies;

  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/workspace-overview",
    async (request, reply) => {
      // These are private authenticated results, including denial responses.
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Authorization");

      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor) {
        return reply
          .code(verified.status)
          .send({ error: verified.error });
      }

      // A tenant URL is an equality check against VERIFIED session tenant.
      // Never trust a body/query/header identity, role or organization ID.
      const actor = verified.actor;
      let client;
      try {
        client = await pool.connect();
      } catch {
        return reply.code(503).send({ error: "unavailable" });
      }

      let active = false;
      try {
        await client.query("BEGIN");
        active = true;

        // One transaction: membership -> role/assignment -> Telegram link ->
        // exact bearer session lock. Concurrent revocations cannot commit
        // ahead of this authorized read's transaction boundary.
        await requireTenantPermission(
          client,
          actor,
          { kind: "organization", tenantId: actor.tenantId },
          "organization.context.read",
        );

        const organization = await client.query<OrganizationRow>(
          `SELECT display_name
             FROM cookie_tenancy.organizations
            WHERE id=$1::uuid`,
          [actor.tenantId],
        );
        const first = organization.rows[0];
        if (!first) throw new AuthorizationDeniedError();

        const result = await client.query<LocationRow>(
          `SELECT id::text, display_name, time_zone
             FROM cookie_tenancy.locations
            WHERE tenant_id=$1::uuid
            ORDER BY display_name, id
            LIMIT $2::integer`,
          [actor.tenantId, MAX_LOCATIONS + 1],
        );
        if (result.rows.length > MAX_LOCATIONS) {
          throw new Error("Organization branch listing exceeds limit");
        }

        const response = {
          organization: {
            organizationId: actor.tenantId,
            displayName: first.display_name,
          },
          locations: result.rows.map((location) => ({
            locationId: location.id,
            displayName: location.display_name,
            timeZone: location.time_zone,
          })),
        };

        await client.query("COMMIT");
        active = false;
        return reply.send(response);
      } catch (error) {
        if (active) {
          try {
            if (error instanceof AuthorizationDeniedError) {
              // A denied read must preserve sanitized authorization audit.
              await client.query("COMMIT");
            } else {
              await client.query("ROLLBACK");
            }
            active = false;
          } catch {
            return reply.code(503).send({ error: "unavailable" });
          }
        }
        if (error instanceof AuthorizationDeniedError) {
          return reply.code(403).send({ error: "forbidden" });
        }
        return reply.code(503).send({ error: "unavailable" });
      } finally {
        client.release();
      }
    },
  );
}
