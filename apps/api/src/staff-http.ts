import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  StaffInputError,
  StaffReferenceNotFound,
  StaffReplayConflict,
  createTenantDraftStaff,
  listTenantStaff,
  validateStaffDraft,
} from "../../../packages/domain-staff/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

type Params = { tenantId: string };
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

export interface RealStaffRoutesDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

/** Authenticated draft staff creation/list. No activation/booking/publish. */
export function registerRealStaffRoutes(
  app: FastifyInstance,
  { pool, verifier }: RealStaffRoutesDependencies,
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!/^\/v1\/organizations\/[^/]+\/staff(?:\?|$)/.test(request.url)) return;
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("Vary", "Authorization");
  });

  app.get<{ Params: Params }>(
    "/v1/organizations/:tenantId/staff",
    async (request, reply) => {
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      try {
        const directory = await withTenantPermission(
          pool,
          verified.actor,
          "staff.profile.read",
          (client) => listTenantStaff(client, verified.actor!.tenantId),
        );
        return reply.send(directory);
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
    "/v1/organizations/:tenantId/staff",
    async (request, reply) => {
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });

      const key = request.headers["idempotency-key"];
      let draft;
      try {
        if (typeof key !== "string" || !KEY.test(key))
          throw new StaffInputError();
        draft = validateStaffDraft(request.body);
      } catch {
        return reply.code(400).send({ error: "invalid-request" });
      }
      try {
        const result = await withTenantPermission(
          pool,
          verified.actor,
          "staff.profile.create",
          (client) =>
            createTenantDraftStaff(
              client,
              verified.actor!.tenantId,
              verified.actor!.identityId,
              key,
              draft,
            ),
        );
        return reply
          .code(result.replayed ? 200 : 201)
          .send({ staff: result.staff });
      } catch (reason) {
        if (reason instanceof StaffReplayConflict) {
          return reply.code(409).send({ error: "idempotency-conflict" });
        }
        if (reason instanceof StaffReferenceNotFound) {
          return reply.code(404).send({ error: "reference-not-found" });
        }
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
}
