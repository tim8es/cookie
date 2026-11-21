import type { FastifyInstance, FastifyReply } from "fastify";
import {
  rescheduleStagingCustomerBooking,
  RescheduleBookingFailure,
} from "../../../packages/domain-booking/src/index.js";
import { readStagingCustomerContext } from "../../../packages/domain-customers/src/index.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import {
  AuthorizationDeniedError,
  requireTenantPermission,
} from "../../../packages/platform-identity/src/index.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";
import { verifyTenantActor } from "./session-context.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;

export interface StagingRescheduleDependencies extends StagingPublicationDependencies {
  readonly cutoffMinutes: number;
}
/** No default or shared cancel cutoff; explicit private-staging operator config only. */
export function parseStagingRescheduleCutoff(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9]\d{0,5})$/.test(raw) || Number(raw) > 525600)
    throw new Error("Invalid staging reschedule cutoff");
  return Number(raw);
}
function privacy(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}
export function registerStagingCustomerReschedule(
  app: FastifyInstance,
  { pool, verifier, enabled, cutoffMinutes }: StagingRescheduleDependencies,
): void {
  if (!enabled) return;
  if (!Number.isSafeInteger(cutoffMinutes) || cutoffMinutes < 0 || cutoffMinutes > 525600)
    throw new Error("Invalid staging reschedule dependency");

  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-reschedule/capability",
    async (request, reply) => {
      privacy(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization, request.params.tenantId, verifier,
      );
      if (!verified.actor) return reply.code(verified.status).send({ error: verified.error });
      if (Object.keys(request.query as object).length !== 0)
        return reply.code(400).send({ error: "invalid-request" });
      const actor = verified.actor;
      try {
        await runSqlTransaction(pool, async (client) => {
          await readStagingCustomerContext(client, actor);
          await requireTenantPermission(client, actor,
            { kind: "customer-self", tenantId: actor.tenantId, clientIdentityId: actor.identityId },
            "staging.customer.booking.reschedule");
        });
        return reply.send({ cutoffMinutes });
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
  app.post<{ Params: { tenantId: string; bookingId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-reschedule/:bookingId",
    async (request, reply) => {
      privacy(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization, request.params.tenantId, verifier,
      );
      if (!verified.actor) return reply.code(verified.status).send({ error: verified.error });
      const key = request.headers["idempotency-key"];
      const body = request.body;
      if (!UUID.test(request.params.bookingId) || typeof key !== "string" || !KEY.test(key) ||
          Object.keys(request.query as object).length !== 0 ||
          !body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !("newStartAt" in body) ||
          typeof body.newStartAt !== "string" || !INSTANT.test(body.newStartAt) ||
          !Number.isFinite(Date.parse(body.newStartAt)) ||
          new Date(body.newStartAt).toISOString() !== body.newStartAt)
        return reply.code(400).send({ error: "invalid-request" });
      try {
        return reply.send(await rescheduleStagingCustomerBooking(pool, {
          actor: verified.actor, bookingId: request.params.bookingId,
          idempotencyKey: key, newStartAt: body.newStartAt.replace(".000Z", "Z"),
        }, cutoffMinutes));
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (error instanceof RescheduleBookingFailure) {
          const status = error.code === "INVALID_RESCHEDULE_COMMAND" ? 400
            : error.code === "BOOKING_NOT_FOUND" ? 404 : 409;
          return reply.code(status).send({ error: error.code });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
