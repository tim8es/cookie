import type { FastifyInstance } from "fastify";
import {
  createStagingCustomerBooking,
  CreateBookingFailure,
  readStagingCreateReceipt,
} from "../../../packages/domain-booking/src/index.js";
import { StagingPublicationDenied } from "../../../packages/domain-entitlement/src/index.js";
import { readStagingCustomerContext } from "../../../packages/domain-customers/src/index.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import {
  AuthorizationDeniedError,
  requireTenantPermission,
} from "../../../packages/platform-identity/src/index.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";
import { verifyTenantActor } from "./session-context.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

function id(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Separate opt-in staging composition. Never mount public booking routes. */
export function registerStagingCustomerBooking(
  app: FastifyInstance,
  { pool, verifier, enabled }: StagingPublicationDependencies,
): void {
  if (!enabled) return;
  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-bookings/capability",
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
            "staging.customer.booking.create",
          );
        });
        return reply.send({ enabled: true });
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-bookings/receipt",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Authorization, Idempotency-Key");
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const key = request.headers["idempotency-key"];
      if (
        typeof key !== "string" ||
        !KEY.test(key) ||
        Object.keys(request.query as object).length !== 0
      ) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      const actor = verified.actor;
      try {
        const receipt = await runSqlTransaction(pool, (client) =>
          readStagingCreateReceipt(client, actor, key),
        );
        if (!receipt)
          return reply.code(404).send({ error: "receipt-unavailable" });
        return reply.send(receipt);
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );

  app.post<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/staging-customer-bookings",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
      reply.header("Vary", "Authorization");
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      const actor = verified.actor;
      if (!actor)
        return reply.code(verified.status).send({ error: verified.error });
      if (!actor.opaqueSessionAuthority)
        return reply.code(403).send({ error: "forbidden" });

      const body = request.body;
      const key = request.headers["idempotency-key"];
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof key !== "string" ||
        !KEY.test(key) ||
        Object.keys(request.query as object).length !== 0
      ) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      const row = body as Record<string, unknown>;
      if (
        Object.keys(row).length !== 4 ||
        !id(row.locationId) ||
        !id(row.staffId) ||
        !id(row.serviceId) ||
        typeof row.startAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(row.startAt) ||
        !Number.isFinite(Date.parse(row.startAt)) ||
        new Date(row.startAt).toISOString() !== row.startAt
      ) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      try {
        const receipt = await createStagingCustomerBooking(pool, {
          actor,
          locationId: row.locationId,
          staffId: row.staffId,
          serviceId: row.serviceId,
          startAt: row.startAt.replace(".000Z", "Z"),
          idempotencyKey: key,
        });
        return reply.code(201).send(receipt);
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (error instanceof StagingPublicationDenied)
          return reply.code(409).send({ error: "grant-unavailable" });
        if (error instanceof CreateBookingFailure) {
          return reply
            .code(error.code === "INVALID_BOOKING_COMMAND" ? 400 : 409)
            .send({ error: error.code });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
