import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  CalendarBranchUnavailable,
  CalendarOverflow,
  CalendarRangeError,
  isCalendarDate,
  readOwnerCalendar,
} from "../../../packages/calendar-read-adapter/src/index.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

export interface OwnerCalendarDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerOwnerCalendar(
  app: FastifyInstance,
  { pool, verifier }: OwnerCalendarDependencies,
): void {
  app.get<{
    Params: { tenantId: string };
    Querystring: { locationId?: unknown; date?: unknown; days?: unknown };
  }>("/v1/organizations/:tenantId/owner-calendar", async (request, reply) => {
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
    const { locationId, date, days } = request.query;
    if (
      Object.keys(request.query).length !== 3 ||
      typeof locationId !== "string" ||
      !UUID.test(locationId) ||
      !isCalendarDate(date) ||
      (days !== "1" && days !== "7")
    )
      return reply.code(400).send({ error: "invalid-request" });
    try {
      const result = await withTenantPermission(
        pool,
        actor,
        "booking.read",
        async (client) => {
          // The current owner and organization-scoped booking.read must both
          // match. A branch-scoped admin or former owner cannot use this route.
          const owner = await client.query(
            `SELECT 1 FROM cookie_tenancy.organizations
              WHERE id=$1::uuid AND owner_identity_id=$2::uuid FOR SHARE`,
            [actor.tenantId, actor.identityId],
          );
          if (owner.rowCount !== 1) throw new AuthorizationDeniedError();
          return readOwnerCalendar(client, actor.tenantId, {
            locationId,
            localDate: date,
            days: days === "1" ? 1 : 7,
          });
        },
      );
      return reply.send(result);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError)
        return reply.code(403).send({ error: "forbidden" });
      if (error instanceof CalendarBranchUnavailable)
        return reply.code(404).send({ error: "branch-unavailable" });
      if (error instanceof CalendarRangeError)
        return reply.code(422).send({ error: "invalid-period" });
      if (error instanceof CalendarOverflow)
        return reply.code(409).send({ error: "period-too-dense" });
      return reply.code(503).send({ error: "unavailable" });
    }
  });
}
