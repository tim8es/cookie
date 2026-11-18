import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import {
  readStagingCapacity,
  StagingPublicationDenied,
} from "../../../packages/domain-entitlement/src/index.js";
import {
  publishStaffForStaging,
  StagingStaffPublicationConflict,
  type StagingStaffPublicationInput,
} from "../../../packages/domain-staff/src/index.js";
import {
  listStagingPublishedShifts,
  publishStagingShift,
} from "../../../packages/domain-scheduling/src/index.js";
import { PublishShiftFailure } from "../../../packages/domain-scheduling/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import type { IdentitySessions } from "../../../packages/platform-identity/src/index.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

export interface StagingPublicationDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
  readonly enabled: boolean;
  readonly identitySessionProviders?: readonly IdentitySessions[];
}
type Params = { tenantId: string };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

function privateReply(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}

function parseInput(value: unknown): StagingStaffPublicationInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 4 ||
    !Object.hasOwn(data, "staffId") ||
    !Object.hasOwn(data, "locationId") ||
    !Object.hasOwn(data, "serviceId") ||
    !Object.hasOwn(data, "expectedServiceRevision") ||
    typeof data.staffId !== "string" ||
    !UUID.test(data.staffId) ||
    typeof data.locationId !== "string" ||
    !UUID.test(data.locationId) ||
    typeof data.serviceId !== "string" ||
    !UUID.test(data.serviceId) ||
    !Number.isSafeInteger(data.expectedServiceRevision) ||
    (data.expectedServiceRevision as number) < 0 ||
    (data.expectedServiceRevision as number) >= 2147483647
  )
    return null;
  return {
    staffId: data.staffId,
    locationId: data.locationId,
    serviceId: data.serviceId,
    expectedServiceRevision: data.expectedServiceRevision as number,
  };
}

export function registerStagingPublicationRoutes(
  app: FastifyInstance,
  { pool, verifier, enabled }: StagingPublicationDependencies,
): void {
  app.get<{ Params: Params }>(
    "/v1/organizations/:tenantId/staging-publication",
    async (request, reply) => {
      privateReply(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      try {
        const capacity = await withTenantPermission(
          pool,
          verified.actor,
          "staging.entitlement.read",
          (client) =>
            readStagingCapacity(client, verified.actor!.tenantId, enabled),
        );
        return reply.send({ capacity });
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

  app.get<{ Params: Params }>(
    "/v1/organizations/:tenantId/staging-shift-publication",
    async (request, reply) => {
      privateReply(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      try {
        return reply.send(
          await withTenantPermission(
            pool,
            verified.actor,
            "schedule.shift.plan.read",
            (client) =>
              listStagingPublishedShifts(client, verified.actor!.tenantId),
          ),
        );
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

  // Normal runtime has no write route unless explicitly enabled by operator.
  if (!enabled) return;
  app.post<{ Params: Params }>(
    "/v1/organizations/:tenantId/staging-shift-publication",
    async (request, reply) => {
      privateReply(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const body = request.body;
      const key = request.headers["idempotency-key"];
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !("shiftId" in body) ||
        typeof body.shiftId !== "string" ||
        !UUID.test(body.shiftId) ||
        !("expectedRevision" in body) ||
        typeof body.expectedRevision !== "number" ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0 ||
        body.expectedRevision > 2147483647 ||
        typeof key !== "string" ||
        !KEY.test(key)
      )
        return reply.code(400).send({ error: "invalid-request" });
      try {
        const publication = await publishStagingShift(
          pool,
          verified.actor,
          body.shiftId,
          body.expectedRevision,
          key,
        );
        return reply.code(200).send({ publication });
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (error instanceof StagingPublicationDenied)
          return reply.code(409).send({ error: error.code });
        if (error instanceof PublishShiftFailure) {
          if (error.code === "INVALID_SHIFT_PUBLISH")
            return reply.code(400).send({ error: "invalid-request" });
          return reply.code(409).send({ error: error.code });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );

  app.post<{ Params: Params }>(
    "/v1/organizations/:tenantId/staging-publication",
    async (request, reply) => {
      privateReply(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const input = parseInput(request.body);
      const key = request.headers["idempotency-key"];
      if (!input || typeof key !== "string" || !KEY.test(key))
        return reply.code(400).send({ error: "invalid-request" });
      try {
        const result = await publishStaffForStaging(
          pool,
          verified.actor,
          key,
          input,
        );
        return reply
          .code(result.replayed ? 200 : 201)
          .send({ publication: result.publication });
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (
          error instanceof StagingPublicationDenied ||
          error instanceof StagingStaffPublicationConflict
        )
          return reply.code(409).send({ error: error.code });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
