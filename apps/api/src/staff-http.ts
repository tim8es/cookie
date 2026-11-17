import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  StaffInputError,
  StaffReplayConflict,
  createTenantDraftStaff,
  listTenantStaffProfiles,
  validateDraftStaff,
} from "../../../packages/domain-staff/src/staff-profiles.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

export interface RealStaffRoutesDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

type Params = { tenantId: string };
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

async function withStaffPermission<T>(
  pool: Pool,
  actor: NonNullable<Awaited<ReturnType<typeof verifyTenantActor>>["actor"]>,
  permission: "staff.profile.read" | "staff.profile.create",
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  let businessStarted = false;
  try {
    await client.query("BEGIN");
    active = true;
    await requireTenantPermission(
      client,
      actor,
      { kind: "organization", tenantId: actor.tenantId },
      permission,
    );
    businessStarted = true;
    const result = await work(client);
    await client.query("COMMIT");
    active = false;
    return result;
  } catch (reason) {
    if (active) {
      // A denied preflight has a sanitized audit; no partial business writes.
      if (reason instanceof AuthorizationDeniedError && !businessStarted) {
        await client.query("COMMIT").catch(() => undefined);
      } else {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    }
    throw reason;
  } finally {
    client.release();
  }
}

function setPrivateHeaders(reply: {
  header(name: string, value: string): unknown;
}): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}

/** Live StaffProfile drafts: absent in normal health-only/unauthenticated mode. */
export function registerRealStaffRoutes(
  app: FastifyInstance,
  { pool, verifier }: RealStaffRoutesDependencies,
): void {
  app.get<{ Params: Params }>(
    "/v1/organizations/:tenantId/staff",
    async (request, reply) => {
      setPrivateHeaders(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor) {
        return reply.code(verified.status).send({ error: verified.error });
      }
      try {
        const staff = await withStaffPermission(
          pool,
          verified.actor,
          "staff.profile.read",
          (client) => listTenantStaffProfiles(client, verified.actor!.tenantId),
        );
        return reply.send({ staff });
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
      setPrivateHeaders(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization,
        request.params.tenantId,
        verifier,
      );
      if (!verified.actor) {
        return reply.code(verified.status).send({ error: verified.error });
      }
      const key = request.headers["idempotency-key"];
      let input;
      try {
        if (typeof key !== "string" || !KEY.test(key)) {
          throw new StaffInputError("invalid idempotency key");
        }
        input = validateDraftStaff(request.body);
      } catch {
        return reply.code(400).send({ error: "invalid-request" });
      }
      try {
        const outcome = await withStaffPermission(
          pool,
          verified.actor,
          "staff.profile.create",
          (client) =>
            createTenantDraftStaff(
              client,
              verified.actor!.tenantId,
              verified.actor!.identityId,
              key,
              input,
            ),
        );
        return reply
          .code(outcome.replayed ? 200 : 201)
          .send({ staff: outcome.staff });
      } catch (reason) {
        if (reason instanceof StaffReplayConflict) {
          return reply.code(409).send({ error: "idempotency-conflict" });
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
