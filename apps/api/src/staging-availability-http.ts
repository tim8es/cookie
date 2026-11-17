import type { FastifyInstance, FastifyReply } from "fastify";
import {
  previewStagingAvailability,
  PreviewUnavailable,
} from "../../../packages/domain-scheduling/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { validateLocalMinute } from "../../../packages/domain-scheduling/src/index.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import { verifyTenantActor } from "./session-context.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";

type Params = { tenantId: string };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function privateReply(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}
function parseSelection(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  if (
    Object.keys(data).length !== 4 ||
    typeof data.staffId !== "string" ||
    !UUID.test(data.staffId) ||
    typeof data.locationId !== "string" ||
    !UUID.test(data.locationId) ||
    typeof data.serviceId !== "string" ||
    !UUID.test(data.serviceId) ||
    typeof data.localDate !== "string"
  )
    return null;
  try {
    validateLocalMinute(data.localDate + "T00:00");
  } catch {
    return null;
  }
  return {
    staffId: data.staffId,
    locationId: data.locationId,
    serviceId: data.serviceId,
    localDate: data.localDate,
  };
}
export function registerStagingAvailabilityRoutes(
  app: FastifyInstance,
  { pool, verifier, enabled }: StagingPublicationDependencies,
): void {
  if (!enabled) return;
  app.get<{ Params: Params }>(
    "/v1/organizations/:tenantId/staging-availability",
    async (request, reply) => {
      privateReply(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const data = parseSelection(request.query);
      if (!data) return reply.code(400).send({ error: "invalid-request" });
      try {
        return reply.send(
          await withTenantPermission(
            pool,
            verified.actor,
            "staging.availability.read",
            (client) =>
              previewStagingAvailability(
                client,
                verified.actor!.tenantId,
                data,
              ),
          ),
        );
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (error instanceof PreviewUnavailable)
          return reply.code(409).send({ error: "target-unavailable" });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
