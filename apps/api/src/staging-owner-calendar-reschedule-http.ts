import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import {
  listStagingOwnerRescheduleSlots,
  rescheduleStagingOwnerBooking,
  RescheduleBookingFailure,
} from "../../../packages/domain-booking/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { runAuditedRead, withTenantPermission } from "./protected-tenant-transaction.js";
import {
  verifyTenantActor,
  type BearerSessionVerifier,
} from "./session-context.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;

export interface StagingOwnerRescheduleDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
  readonly enabled: boolean;
  readonly cutoffMinutes: number;
}

/** Explicit private operator setting, independent of cancellation/customer. */
export function parseStagingOwnerRescheduleCutoff(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9]\d{0,5})$/.test(raw) || Number(raw) > 525600)
    throw new Error("Invalid staging owner reschedule cutoff");
  return Number(raw);
}
function privacy(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}

export function registerStagingOwnerCalendarReschedule(
  app: FastifyInstance,
  { pool, verifier, enabled, cutoffMinutes }: StagingOwnerRescheduleDependencies,
): void {
  if (!enabled) return;
  if (
    !Number.isSafeInteger(cutoffMinutes) ||
    cutoffMinutes < 0 ||
    cutoffMinutes > 525600
  ) throw new Error("Invalid staging owner reschedule dependency");

  async function requireOwner(
    actor: NonNullable<Awaited<ReturnType<typeof verifyTenantActor>>["actor"]>,
  ): Promise<void> {
    await withTenantPermission(pool, actor, "booking.reschedule", async (client) => {
      const result = await client.query(
        `SELECT 1 FROM cookie_tenancy.organizations
           WHERE id=$1::uuid AND owner_identity_id=$2::uuid FOR SHARE`,
        [actor.tenantId, actor.identityId],
      );
      if (result.rowCount !== 1) throw new AuthorizationDeniedError();
      return true;
    });
  }

  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/owner-calendar/reschedule/capability",
    async (request, reply) => {
      privacy(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization, request.params.tenantId, verifier,
      );
      if (!verified.actor) return reply.code(verified.status).send({ error: verified.error });
      if (Object.keys(request.query as object).length !== 0)
        return reply.code(400).send({ error: "invalid-request" });
      try {
        await requireOwner(verified.actor);
        return reply.send({ cutoffMinutes });
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );

  app.get<{
    Params: { tenantId: string; bookingId: string };
    Querystring: { locationId?: unknown; localDate?: unknown };
  }>(
    "/v1/organizations/:tenantId/owner-calendar/:bookingId/reschedule/slots",
    async (request, reply) => {
      privacy(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization, request.params.tenantId, verifier,
      );
      if (!verified.actor) return reply.code(verified.status).send({ error: verified.error });
      const q = request.query as Record<string, unknown>;
      if (
        !UUID.test(request.params.bookingId) ||
        Object.keys(q).length !== 2 ||
        typeof q.locationId !== "string" ||
        !UUID.test(q.locationId) ||
        typeof q.localDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(q.localDate) ||
        !Number.isFinite(Date.parse(q.localDate + "T00:00:00Z")) ||
        new Date(q.localDate + "T00:00:00Z").toISOString().slice(0, 10) !== q.localDate
      ) return reply.code(400).send({ error: "invalid-request" });
      try {
        return reply.send(await runAuditedRead(pool, (client) =>
          listStagingOwnerRescheduleSlots(
            client, verified.actor!, request.params.bookingId,
            q.locationId as string, q.localDate as string, cutoffMinutes,
          ),
        ));
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (error instanceof RescheduleBookingFailure)
          return reply.code(error.code === "BOOKING_NOT_FOUND" ? 404 : 409)
            .send({ error: error.code });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );

  app.post<{
    Params: { tenantId: string; bookingId: string };
    Querystring: { locationId?: unknown };
  }>(
    "/v1/organizations/:tenantId/owner-calendar/:bookingId/reschedule",
    async (request, reply) => {
      privacy(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization, request.params.tenantId, verifier,
      );
      if (!verified.actor) return reply.code(verified.status).send({ error: verified.error });
      const q = request.query as Record<string, unknown>;
      const key = request.headers["idempotency-key"];
      const body = request.body;
      if (
        !UUID.test(request.params.bookingId) ||
        Object.keys(q).length !== 1 ||
        typeof q.locationId !== "string" ||
        !UUID.test(q.locationId) ||
        typeof key !== "string" ||
        !KEY.test(key) ||
        !body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("newStartAt" in body) ||
        typeof body.newStartAt !== "string" ||
        !INSTANT.test(body.newStartAt) ||
        !Number.isFinite(Date.parse(body.newStartAt)) ||
        new Date(body.newStartAt).toISOString() !== body.newStartAt
      ) return reply.code(400).send({ error: "invalid-request" });
      try {
        return reply.send(await rescheduleStagingOwnerBooking(
          pool,
          {
            actor: verified.actor,
            bookingId: request.params.bookingId,
            idempotencyKey: key,
            newStartAt: body.newStartAt.replace(".000Z", "Z"),
          },
          q.locationId,
          cutoffMinutes,
        ));
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (error instanceof RescheduleBookingFailure) {
          const status = error.code === "INVALID_RESCHEDULE_COMMAND"
            ? 400 : error.code === "BOOKING_NOT_FOUND" ? 404 : 409;
          return reply.code(status).send({ error: error.code });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
