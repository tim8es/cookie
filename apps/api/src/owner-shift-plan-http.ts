import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import {
  createOwnerShiftPlan,
  DraftShiftFailure,
  type OwnerShiftPlanInput,
  listOwnerShiftPlans,
} from "../../../packages/domain-scheduling/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

export interface OwnerShiftPlanRouteDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

type Params = { tenantId: string };
type Draft = Pick<
  OwnerShiftPlanInput,
  "staffId" | "locationId" | "startLocal" | "endLocal"
>;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function privateReply(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}

function validateBody(body: unknown): Draft | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    !Object.hasOwn(record, "staffId") ||
    !Object.hasOwn(record, "locationId") ||
    !Object.hasOwn(record, "startLocal") ||
    !Object.hasOwn(record, "endLocal") ||
    typeof record.staffId !== "string" ||
    !UUID.test(record.staffId) ||
    typeof record.locationId !== "string" ||
    !UUID.test(record.locationId) ||
    typeof record.startLocal !== "string" ||
    typeof record.endLocal !== "string" ||
    record.startLocal.length !== 16 ||
    record.endLocal.length !== 16
  )
    return null;
  return {
    staffId: record.staffId,
    locationId: record.locationId,
    startLocal: record.startLocal,
    endLocal: record.endLocal,
  };
}

export function registerOwnerShiftPlanRoutes(
  app: FastifyInstance,
  { pool, verifier }: OwnerShiftPlanRouteDependencies,
): void {
  app.get<{ Params: Params }>(
    "/v1/organizations/:tenantId/shift-plans",
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
            (client) => listOwnerShiftPlans(client, verified.actor!.tenantId),
          ),
        );
      } catch (reason) {
        return reply
          .code(reason instanceof AuthorizationDeniedError ? 403 : 503)
          .send({
            error:
              reason instanceof AuthorizationDeniedError
                ? "forbidden"
                : "unavailable",
          });
      }
    },
  );

  app.post<{ Params: Params }>(
    "/v1/organizations/:tenantId/shift-plans",
    async (request, reply) => {
      privateReply(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const key = request.headers["idempotency-key"];
      const draft = validateBody(request.body);
      if (typeof key !== "string" || !KEY.test(key) || !draft) {
        return reply.code(400).send({ error: "invalid-request" });
      }
      try {
        // Domain command holds Staff -> policy -> assignment/zone locks. Do
        // NOT wrap with a separate policy-first transaction (deadlock risk).
        const result = await createOwnerShiftPlan(pool, {
          actor: verified.actor,
          idempotencyKey: key,
          ...draft,
        });
        return reply
          .code(result.replayed ? 200 : 201)
          .send({ plan: result.receipt });
      } catch (reason) {
        if (reason instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (reason instanceof DraftShiftFailure) {
          if (reason.code === "DRAFT_KEY_REUSED")
            return reply.code(409).send({ error: "idempotency-conflict" });
          if (reason.code === "DRAFT_TARGET_UNAVAILABLE")
            return reply.code(409).send({ error: "target-unavailable" });
          if (reason.code === "DRAFT_LOCAL_TIME_INVALID")
            return reply.code(422).send({ error: "local-time-invalid" });
          if (reason.code === "INVALID_DRAFT_COMMAND")
            return reply.code(400).send({ error: "invalid-request" });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
