import type { FastifyInstance } from "fastify";
import { runAuditedRead } from "./protected-tenant-transaction.js";
import { readStagingCustomerContext } from "../../../packages/domain-customers/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { verifyTenantActor } from "./session-context.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";

export function registerStagingCustomerContext(
  app: FastifyInstance,
  { pool, verifier, enabled }: StagingPublicationDependencies,
): void {
  if (!enabled) return;
  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-context",
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
      try {
        const context = await runAuditedRead(pool, (client) =>
          readStagingCustomerContext(client, verified.actor!),
        );
        return reply.send(context);
      } catch (error) {
        return reply
          .code(error instanceof AuthorizationDeniedError ? 403 : 503)
          .send({
            error:
              error instanceof AuthorizationDeniedError
                ? "forbidden"
                : "unavailable",
          });
      }
    },
  );
}
