import type { FastifyInstance } from "fastify";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import {
  enrollStagingCustomerInTransaction,
  readStagingCustomerContext,
} from "../../../packages/domain-customers/src/index.js";
import { runAuditedRead } from "./protected-tenant-transaction.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import {
  lockLiveStagingGrant,
  StagingPublicationDenied,
} from "../../../packages/domain-entitlement/src/index.js";
import { verifyTenantActor } from "./session-context.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/** Explicit client enrollment for a published private-staging organization. */
export function registerStagingCustomerEnrollment(
  app: FastifyInstance,
  dependencies: StagingPublicationDependencies,
): void {
  const { pool, enabled } = dependencies;
  const providers = dependencies.identitySessionProviders ?? [];
  if (!enabled || providers.length === 0) return;

  app.post<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer/enroll",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Authorization");
      const token = /^Bearer (is_[A-Za-z0-9_-]{43})$/.exec(
        request.headers.authorization ?? "",
      )?.[1];
      const body: unknown = request.body;
      if (
        !token ||
        !UUID.test(request.params.tenantId) ||
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("consentConfirmed" in body) ||
        body.consentConfirmed !== true ||
        Object.keys(request.query as object).length !== 0
      ) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      try {
        const customer = await runSqlTransaction(pool, async (client) => {
          let identityId: string | null = null;
          for (const provider of providers) {
            identityId = await provider.resolveWithinTransaction(client, token);
            if (identityId) break;
          }
          if (!identityId) return null;
          await lockLiveStagingGrant(client, request.params.tenantId);
          return enrollStagingCustomerInTransaction(
            client,
            request.params.tenantId,
            identityId,
            true,
          );
        });
        if (!customer)
          return reply.code(401).send({ error: "unauthenticated" });
        return reply.code(200).send(customer);
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (
          error instanceof StagingPublicationDenied &&
          error.code === "grant-unavailable"
        ) {
          return reply.code(409).send({ error: "grant-unavailable" });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
