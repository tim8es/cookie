import type { FastifyInstance } from "fastify";

import { listOwnStagingBookings } from "../../../packages/domain-booking/src/index.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { verifyTenantActor } from "./session-context.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";

export function registerStagingCustomerHistory(
  app: FastifyInstance,
  { pool, verifier, enabled }: StagingPublicationDependencies,
): void {
  if (!enabled) return;
  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-history",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Authorization");
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      if (Object.keys(request.query as object).length !== 0)
        return reply.code(400).send({ error: "invalid-request" });
      const actor = verified.actor;
      try {
        const result = await runSqlTransaction(pool, (client) =>
          listOwnStagingBookings(client, actor),
        );
        return reply.send(result);
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          return reply.code(403).send({ error: "forbidden" });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
