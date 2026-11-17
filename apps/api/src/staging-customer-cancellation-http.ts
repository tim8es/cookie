import type { FastifyInstance } from "fastify";
import {
  cancelStagingCustomerBooking,
  CancelBookingFailure,
} from "../../../packages/domain-booking/src/index.js";
import { readStagingCustomerContext } from "../../../packages/domain-customers/src/index.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import {
  AuthorizationDeniedError,
  requireTenantPermission,
} from "../../../packages/platform-identity/src/index.js";
import { verifyTenantActor } from "./session-context.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";

export interface StagingCancellationDependencies
  extends StagingPublicationDependencies {
  readonly cutoffMinutes: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

/** No implicit commercial deadline. Undefined means no cancellation route. */
export function parseStagingCancellationCutoff(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 10080) {
    throw new Error("Invalid explicit staging cancellation cutoff");
  }
  return Number(raw);
}

export function registerStagingCustomerCancellation(
  app: FastifyInstance,
  { pool, verifier, enabled, cutoffMinutes }: StagingCancellationDependencies,
): void {
  if (!enabled) return;
  if (!Number.isInteger(cutoffMinutes) || cutoffMinutes < 0 || cutoffMinutes > 10080)
    throw new Error("Invalid staging cancellation cutoff");
  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-cancellation/capability",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Vary", "Authorization");
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const actor = verified.actor;
      try {
        await runSqlTransaction(pool, async (client) => {
          await readStagingCustomerContext(client, actor);
          await requireTenantPermission(
            client,
            actor,
            {
              kind: "customer-self",
              tenantId: actor.tenantId,
              clientIdentityId: actor.identityId,
            },
            "staging.customer.booking.cancel",
          );
        });
        return reply.send({ cutoffMinutes });
      } catch (reason) {
        return reply
          .code(reason instanceof AuthorizationDeniedError ? 403 : 503)
          .send({ error: "unavailable" });
      }
    },
  );
  app.post<{ Params: { tenantId: string; bookingId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-cancellation/:bookingId",
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
      const actor = verified.actor;
      const key = request.headers["idempotency-key"];
      if (
        !UUID.test(request.params.bookingId) ||
        typeof key !== "string" ||
        !KEY.test(key) ||
        request.body !== undefined ||
        Object.keys(request.query as object).length !== 0
      ) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      try {
        const receipt = await cancelStagingCustomerBooking(
          pool,
          { actor, bookingId: request.params.bookingId, idempotencyKey: key },
          cutoffMinutes,
        );
        return reply.send(receipt);
      } catch (reason) {
        if (reason instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (reason instanceof CancelBookingFailure) {
          const status = reason.code === "BOOKING_NOT_FOUND" ? 404 : 409;
          return reply.code(status).send({ error: reason.code });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
