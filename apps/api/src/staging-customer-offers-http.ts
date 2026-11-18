import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { runAuditedRead } from "./protected-tenant-transaction.js";
import {
  listStagingCustomerOffers,
  listStagingCustomerSlots,
} from "../../../packages/domain-customers/src/index.js";
import { PreviewUnavailable } from "../../../packages/domain-scheduling/src/index.js";
import { validateLocalMinute } from "../../../packages/domain-scheduling/src/index.js";
import {
  AuthorizationDeniedError,
  type TrustedActor,
} from "../../../packages/platform-identity/src/index.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";
import { verifyTenantActor } from "./session-context.js";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function headers(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}
export function registerStagingCustomerOffers(
  app: FastifyInstance,
  { pool, verifier, enabled }: StagingPublicationDependencies,
): void {
  if (!enabled) return;
  async function read(
    reply: FastifyReply,
    actor: TrustedActor,
    action: (client: PoolClient, actor: TrustedActor) => Promise<unknown>,
  ) {
    try {
      return reply.send(
        await runAuditedRead(pool, (client) => action(client, actor)),
      );
    } catch (error) {
      if (error instanceof AuthorizationDeniedError)
        return reply.code(403).send({ error: "forbidden" });
      if (error instanceof PreviewUnavailable)
        return reply.code(409).send({ error: "target-unavailable" });
      return reply.code(503).send({ error: "unavailable" });
    }
  }

  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-offers",
    async (req, reply) => {
      headers(reply);
      const verified = await verifyTenantActor(
        req.headers.authorization,
        req.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      if (Object.keys(req.query as object).length !== 0)
        return reply.code(400).send({ error: "invalid-request" });
      return read(reply, verified.actor, listStagingCustomerOffers);
    },
  );
  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-slots",
    async (req, reply) => {
      headers(reply);
      const verified = await verifyTenantActor(
        req.headers.authorization,
        req.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const q = req.query as Record<string, unknown>;
      if (
        Object.keys(q).length !== 4 ||
        typeof q.locationId !== "string" ||
        !UUID.test(q.locationId) ||
        typeof q.staffId !== "string" ||
        !UUID.test(q.staffId) ||
        typeof q.serviceId !== "string" ||
        !UUID.test(q.serviceId) ||
        typeof q.localDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(q.localDate)
      )
        return reply.code(400).send({ error: "invalid-request" });
      const selection = {
        locationId: q.locationId,
        staffId: q.staffId,
        serviceId: q.serviceId,
        localDate: q.localDate,
      };
      try {
        validateLocalMinute(selection.localDate + "T00:00");
      } catch {
        return reply.code(400).send({ error: "invalid-request" });
      }
      return read(reply, verified.actor, (client, actor) =>
        listStagingCustomerSlots(client, actor, selection),
      );
    },
  );
}
