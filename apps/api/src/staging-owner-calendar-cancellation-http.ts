import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import {
  cancelStagingOwnerBooking,
  CancelBookingFailure,
} from "../../../packages/domain-booking/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/index.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import { verifyTenantActor, type BearerSessionVerifier } from "./session-context.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

export interface StagingOwnerCancellationDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
  readonly cutoffMinutes: number;
  readonly enabled: boolean;
}

/** Explicit operator-only private staging cutoff. Not the salon policy. */
export function parseStagingOwnerCancellationCutoff(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9]\d{0,5})$/.test(raw) || Number(raw) > 525600)
    throw new Error("Invalid staging owner cancellation cutoff");
  return Number(raw);
}
function privacy(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Authorization");
}

export function registerStagingOwnerCalendarCancellation(
  app: FastifyInstance,
  { pool, verifier, cutoffMinutes, enabled }: StagingOwnerCancellationDependencies,
): void {
  if (!enabled) return;
  if (!Number.isSafeInteger(cutoffMinutes) || cutoffMinutes < 0 ||
      cutoffMinutes > 525600) {
    throw new Error("Invalid staging owner cancellation dependency");
  }

  async function requireCurrentOwner(
    actor: Awaited<ReturnType<typeof verifyTenantActor>>["actor"],
    locationId?: string,
    bookingId?: string,
  ): Promise<boolean> {
    if (!actor) throw new AuthorizationDeniedError();
    return withTenantPermission(pool, actor, "booking.cancel", async (client) => {
      const owner = await client.query(
        `SELECT 1 FROM cookie_tenancy.organizations
          WHERE id=$1::uuid AND owner_identity_id=$2::uuid FOR SHARE`,
        [actor.tenantId, actor.identityId],
      );
      if (owner.rowCount !== 1) throw new AuthorizationDeniedError();
      if (!locationId || !bookingId) return true;
      const matches = await client.query(
        `SELECT 1 FROM cookie_booking.bookings
          WHERE tenant_id=$1::uuid AND location_id=$2::uuid AND id=$3::uuid`,
        [actor.tenantId, locationId, bookingId],
      );
      return matches.rowCount === 1;
    });
  }

  app.get<{ Params: { tenantId: string } }>(
    "/v1/organizations/:tenantId/owner-calendar/cancellation/capability",
    async (request, reply) => {
      privacy(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization, request.params.tenantId, verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      if (Object.keys(request.query as object).length !== 0)
        return reply.code(400).send({ error: "invalid-request" });
      try {
        await requireCurrentOwner(verified.actor);
        return reply.send({ cutoffMinutes });
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );

  app.post<{
    Params: { tenantId: string; bookingId: string };
    Querystring: { locationId?: unknown };
  }>(
    "/v1/organizations/:tenantId/owner-calendar/:bookingId/cancel",
    async (request, reply) => {
      privacy(reply);
      const verified = await verifyTenantActor(
        request.headers.authorization, request.params.tenantId, verifier,
      );
      if (!verified.actor)
        return reply.code(verified.status).send({ error: verified.error });
      const key = request.headers["idempotency-key"];
      const { bookingId } = request.params;
      const q = request.query as Record<string, unknown>;
      if (!UUID.test(bookingId) ||
          Object.keys(q).length !== 1 ||
          typeof q.locationId !== "string" ||
          !UUID.test(q.locationId) ||
          typeof key !== "string" || !KEY.test(key) ||
          !request.body || typeof request.body !== "object" ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length !== 0)
        return reply.code(400).send({ error: "invalid-request" });
      const actor = verified.actor;
      const locationId = q.locationId;
      try {
        if (!await requireCurrentOwner(actor, locationId, bookingId))
          return reply.code(404).send({ error: "booking-not-found" });
        const receipt = await cancelStagingOwnerBooking(
          pool,
          { actor, bookingId, idempotencyKey: key },
          cutoffMinutes,
          async (client, booking) => {
            // A preflight is never the mutation's authority. Hold the exact
            // tenant-owner row lock through the committing cancellation.
            const owner = await client.query(
              `SELECT 1 FROM cookie_tenancy.organizations
                WHERE id=$1::uuid AND owner_identity_id=$2::uuid FOR SHARE`,
              [actor.tenantId, actor.identityId],
            );
            if (owner.rowCount !== 1 || booking.locationId !== locationId)
              throw new AuthorizationDeniedError();
            const allowed = await client.query(
              "SELECT 1 WHERE $1::timestamptz > clock_timestamp() + $2::int * interval '1 minute'",
              [booking.startAt, cutoffMinutes],
            );
            if (allowed.rowCount !== 1)
              throw new CancelBookingFailure("CANCELLATION_POLICY_DENIED");
          },
        );
        return reply.send(receipt);
      } catch (error) {
        if (error instanceof AuthorizationDeniedError)
          return reply.code(403).send({ error: "forbidden" });
        if (error instanceof CancelBookingFailure) {
          const status = error.code === "INVALID_CANCELLATION_COMMAND"
            ? 400 : error.code === "BOOKING_NOT_FOUND" ? 404 : 409;
          return reply.code(status).send({ error: error.code });
        }
        return reply.code(503).send({ error: "unavailable" });
      }
    },
  );
}
