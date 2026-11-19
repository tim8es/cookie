import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import {
  appendAuthIdentityAudit,
  OwnerWorkspaceProvisionError,
  provisionOwnerWorkspaceInTransaction,
  type IdentitySessions,
} from "../../../packages/platform-identity/src/index.js";

const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const IDENTITY_BEARER = /^is_[A-Za-z0-9_-]{43}$/;

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization, Idempotency-Key");
}

/** Create an owner workspace only from a locked, server-verified Identity session. */
export function registerOwnerWorkspaceEnrollment(
  app: FastifyInstance,
  dependencies: {
    readonly pool: Pool;
    readonly identitySessionProviders: readonly IdentitySessions[];
  },
): void {
  app.post("/v1/auth/owner/workspace", async (request, reply) => {
    noStore(reply);
    const token = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    const key = request.headers["idempotency-key"];
    const body: unknown = request.body;
    if (
      !token ||
      !IDENTITY_BEARER.test(token) ||
      typeof key !== "string" ||
      !KEY.test(key) ||
      !exactObject(body, ["organizationName", "locationName", "timeZone"]) ||
      typeof body.organizationName !== "string" ||
      typeof body.locationName !== "string" ||
      typeof body.timeZone !== "string"
    ) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }

    try {
      const result = await runSqlTransaction(
        dependencies.pool,
        async (client) => {
          let identityId: string | null = null;
          for (const provider of dependencies.identitySessionProviders) {
            identityId = await provider.resolveWithinTransaction(client, token);
            if (identityId) break;
          }
          if (!identityId) return null;
          const provisioned = await provisionOwnerWorkspaceInTransaction(
            client,
            {
              ownerIdentityId: identityId,
              idempotencyKey: key,
              organizationName: body.organizationName as string,
              locationName: body.locationName as string,
              timeZone: body.timeZone as string,
            },
          );
          if (!provisioned.replayed)
            await appendAuthIdentityAudit(
              client,
              "owner_workspace_created",
              identityId,
            );
          return provisioned;
        },
      );
      if (!result) return reply.code(401).send({ error: "UNAUTHENTICATED" });
      return reply.code(result.replayed ? 200 : 201).send({
        tenantId: result.tenantId,
        locationId: result.locationId,
        replayed: result.replayed,
      });
    } catch (error) {
      if (error instanceof OwnerWorkspaceProvisionError) {
        return reply
          .code(error.code === "IDEMPOTENCY_KEY_REUSED" ? 409 : 400)
          .send({ error: error.code });
      }
      return reply.code(503).send({ error: "BACKEND_UNAVAILABLE" });
    }
  });
}
