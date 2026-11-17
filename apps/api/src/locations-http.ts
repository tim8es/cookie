import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  LocationCapacityExceeded,
  LocationInputError,
  LocationReplayConflict,
  createTenantLocation,
  listTenantLocations,
  validateCreateLocation,
} from "../../../packages/domain-tenancy/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

export interface RealLocationRouteDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

type Params = { tenantId: string };
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

function privateReply(reply: {
  header(key: string, value: string): unknown;
}): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}

/** Live owner locations. No public discovery, Booking or unpublished routes. */
export function registerRealLocationRoutes(
  app: FastifyInstance,
  { pool, verifier }: RealLocationRouteDependencies,
): void {
  app.get<{ Params: Params }>(
    "/v1/organizations/:tenantId/locations",
    async (request, reply) => {
      privateReply(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor) {
        return reply.code(verified.status).send({ error: verified.error });
      }
      try {
        const locations = await withTenantPermission(
          pool,
          verified.actor,
          "location.read",
          (client) => listTenantLocations(client, verified.actor!.tenantId),
        );
        return reply.send({ locations });
      } catch (reason) {
        return reply
          .code(reason instanceof AuthorizationDeniedError ? 403 : 503)
          .send({
            error:
              reason instanceof AuthorizationDeniedError
                ? "forbidden"
                : "unavailable",
          });
      }
    },
  );

  app.post<{ Params: Params }>(
    "/v1/organizations/:tenantId/locations",
    async (request, reply) => {
      privateReply(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor) {
        return reply.code(verified.status).send({ error: verified.error });
      }
      const key = request.headers["idempotency-key"];
      let draft;
      try {
        if (typeof key !== "string" || !KEY.test(key)) {
          throw new LocationInputError("invalid idempotency key");
        }
        draft = validateCreateLocation(request.body);
      } catch {
        return reply.code(400).send({ error: "invalid-request" });
      }

      try {
        const result = await withTenantPermission(
          pool,
          verified.actor,
          "location.create",
          (client) =>
            createTenantLocation(
              client,
              verified.actor!.tenantId,
              verified.actor!.identityId,
              key,
              draft,
            ),
        );
        return reply
          .code(result.replayed ? 200 : 201)
          .send({ location: result.location });
      } catch (reason) {
        if (reason instanceof LocationReplayConflict) {
          return reply.code(409).send({ error: "idempotency-conflict" });
        }
        if (reason instanceof LocationCapacityExceeded) {
          return reply.code(409).send({ error: "location-limit" });
        }
        return reply
          .code(reason instanceof AuthorizationDeniedError ? 403 : 503)
          .send({
            error:
              reason instanceof AuthorizationDeniedError
                ? "forbidden"
                : "unavailable",
          });
      }
    },
  );
}
