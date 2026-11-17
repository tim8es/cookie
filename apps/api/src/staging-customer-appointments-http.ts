import type { FastifyInstance } from "fastify";
import { listStagingCustomerAppointments } from "../../../packages/domain-customers/src/index.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";
import { verifyTenantActor } from "./session-context.js";

/** Explicit staging read capability, independent of the create switch. */
export function registerStagingCustomerAppointments(
  app: FastifyInstance,
  { pool, verifier, enabled }: StagingPublicationDependencies,
): void {
  if (!enabled) return;
  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-appointments",
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Authorization");
      const verified = await verifyTenantActor(
        req.headers.authorization,
        req.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      if (Object.keys(req.query as object).length !== 0)
        return reply.code(400).send({ error: "invalid-request" });
      try {
        const result = await runSqlTransaction(pool, (client) =>
          listStagingCustomerAppointments(client, verified.actor!),
        );
        return reply.send(result);
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
