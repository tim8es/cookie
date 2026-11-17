import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  CatalogInputError,
  CatalogReplayConflict,
  createTenantDraftService,
  listTenantServices,
  validateDraftService,
} from "../../../packages/domain-catalog/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";

export interface RealCatalogRouteDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
type Params = { tenantId: string };

/** Real, tenant-scoped draft catalog. NOT an opt-in synthetic Booking adapter. */
export function registerRealCatalogRoutes(
  app: FastifyInstance,
  { pool, verifier }: RealCatalogRouteDependencies,
): void {
  app.addHook("onRequest", async (request, reply) => {
    // Route-local paths are under /services only; no protected content in caches.
    if (!/^\/v1\/organizations\/[^/]+\/services(?:\?|$)/.test(request.url))
      return;
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Authorization");
  });

  app.get<{ Params: Params }>(
    "/v1/organizations/:tenantId/services",
    async (request, reply) => {
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      try {
        const services = await withTenantPermission(
          pool,
          verified.actor,
          "catalog.service.read",
          (client) => listTenantServices(client, verified.actor!.tenantId),
        );
        return reply.send({ services });
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
    "/v1/organizations/:tenantId/services",
    async (request, reply) => {
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });

      const key = request.headers["idempotency-key"];
      let input;
      try {
        if (typeof key !== "string" || !KEY.test(key))
          throw new CatalogInputError();
        input = validateDraftService(request.body);
      } catch {
        return reply.code(400).send({ error: "invalid-request" });
      }
      try {
        const result = await withTenantPermission(
          pool,
          verified.actor,
          "catalog.service.create",
          (client) =>
            createTenantDraftService(
              client,
              verified.actor!.tenantId,
              verified.actor!.identityId,
              key,
              input,
            ),
        );
        return reply
          .code(result.replayed ? 200 : 201)
          .send({ service: result.service });
      } catch (reason) {
        if (reason instanceof CatalogReplayConflict) {
          return reply.code(409).send({ error: "idempotency-conflict" });
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
