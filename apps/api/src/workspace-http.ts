import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  AuthorizationDeniedError,
  evaluateAuthorization,
  type TrustedActor,
} from "../../../packages/platform-identity/src/authorization.js";
import {
  assertActiveOpaqueSession,
  loadPolicySnapshot,
  lockPolicyRows,
  requireTenantPermission,
} from "../../../packages/platform-identity/src/postgres.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

/** Explicitly test-harness-only workspace and staff schedule read adapter. */
export interface SyntheticWorkspaceReadDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
type TenantParams = { tenantId: string };
type StaffScheduleParams = TenantParams & {
  locationId: string;
  staffId: string;
};
type IntervalRow = QueryResultRow & { start_at: Date; end_at: Date };
type BlockedRow = IntervalRow & { kind: "break" | "exception" };
type LocationRow = QueryResultRow & {
  id: string;
  display_name: string;
  time_zone: string | null;
};
type StaffRow = QueryResultRow & {
  staff_name: string;
  time_zone: string | null;
};
type ReplyPort = { code(status: number): { send(value: unknown): unknown } };

function errorReply(reply: ReplyPort, status: number, code: string): unknown {
  return reply.code(status).send({ error: { code } });
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

async function readTransaction<T>(
  pool: Pool,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const result = await read(client);
    await client.query("COMMIT");
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function handleFailure(error: unknown, reply: ReplyPort): unknown {
  if (error instanceof AuthorizationDeniedError) {
    return errorReply(reply, 403, "ACCESS_DENIED");
  }
  return errorReply(reply, 503, "BACKEND_UNAVAILABLE");
}

function range(row: IntervalRow) {
  return {
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
  };
}

export function registerSyntheticWorkspaceReads(
  app: FastifyInstance,
  dependencies: SyntheticWorkspaceReadDependencies,
): void {
  const { pool, verifier } = dependencies;

  async function authenticated(
    authorization: string | undefined,
    tenantId: string,
    reply: ReplyPort,
  ): Promise<TrustedActor | null> {
    const result = await verifyTenantActor(authorization, tenantId, verifier);
    if (!result.actor) {
      errorReply(
        reply,
        result.status,
        result.error === "forbidden" ? "ACCESS_DENIED" : "UNAUTHENTICATED",
      );
      return null;
    }
    return result.actor;
  }

  app.get<{ Params: TenantParams }>(
    "/v1/organizations/:tenantId/workspace-context",
    async (request, reply) => {
      const actor = await authenticated(
        request.headers.authorization,
        request.params.tenantId,
        reply,
      );
      if (!actor) return reply;
      try {
        const result = await readTransaction(pool, async (client) => {
          // This response grants either booking.read or booking.create
          // at each location; lock ALL contributing policy rows, rather than
          // requiring one global permission, before evaluating the snapshot.
          // Keep Membership/Role -> Telegram link -> Cookie session lock
          // order consistent with mutating commands and revocation triggers.
          await lockPolicyRows(client, actor);
          await assertActiveOpaqueSession(client, actor);
          // PoolClient is a single PostgreSQL connection: issue reads
          // sequentially to avoid overlapping queries on one client.
          const org = await client.query<{ display_name: string }>(
            "SELECT display_name FROM cookie_tenancy.organizations WHERE id=$1::uuid",
            [actor.tenantId],
          );
          const locationRows = await client.query<LocationRow>(
            `SELECT id::text, display_name, time_zone
               FROM cookie_tenancy.locations
              WHERE tenant_id=$1::uuid ORDER BY display_name, id LIMIT 101`,
            [actor.tenantId],
          );
          const policy = await loadPolicySnapshot(client, actor);
          if (locationRows.rows.length > 100) {
            throw new Error(
              "Workspace exceeds bounded synthetic location list",
            );
          }
          const locations = locationRows.rows.flatMap((location) => {
            const allowed = (permission: string) =>
              evaluateAuthorization(
                {
                  actor,
                  resource: {
                    kind: "organization",
                    tenantId: actor.tenantId,
                    locationId: location.id,
                  },
                  permission,
                },
                policy,
              ).allowed;
            const canCreateBooking =
              Boolean(location.time_zone) && allowed("booking.create");
            const canReadBookings = allowed("booking.read");
            if (!canCreateBooking && !canReadBookings) return [];
            return [
              {
                locationId: location.id,
                displayName: location.display_name,
                timeZone: location.time_zone,
                canCreateBooking,
                canReadBookings,
              },
            ];
          });
          // Do not reveal organization metadata or foreign branch IDs when
          // there is no scoped permission on ANY location.
          if (!org.rows[0] || locations.length === 0) {
            throw new AuthorizationDeniedError();
          }
          return {
            organization: {
              organizationId: actor.tenantId,
              displayName: org.rows[0].display_name,
            },
            locations,
          };
        });
        return reply.send(result);
      } catch (error) {
        return handleFailure(error, reply);
      }
    },
  );

  app.get<{
    Params: StaffScheduleParams;
    Querystring: { from?: string; to?: string };
  }>(
    "/v1/organizations/:tenantId/locations/:locationId/staff/:staffId/schedule",
    async (request, reply) => {
      const actor = await authenticated(
        request.headers.authorization,
        request.params.tenantId,
        reply,
      );
      if (!actor) return reply;
      const { locationId, staffId } = request.params;
      const { from, to } = request.query;
      if (
        !UUID.test(locationId) ||
        !UUID.test(staffId) ||
        !validInstant(from) ||
        !validInstant(to) ||
        Date.parse(from) >= Date.parse(to) ||
        Date.parse(to) - Date.parse(from) > 7 * 86_400_000
      ) {
        return errorReply(reply, 400, "INVALID_REQUEST");
      }
      try {
        const schedule = await readTransaction(pool, async (client) => {
          await requireTenantPermission(
            client,
            actor,
            {
              kind: "schedule",
              tenantId: actor.tenantId,
              locationId,
              staffProfileId: staffId,
            },
            "schedule.read",
          );
          const staff = await client.query<StaffRow>(
            `SELECT staff.display_name AS staff_name, loc.time_zone
               FROM cookie_staff.location_assignments assignment
               JOIN cookie_staff.staff_profiles staff
                 ON staff.tenant_id=assignment.tenant_id
                AND staff.id=assignment.staff_id
               JOIN cookie_tenancy.locations loc
                 ON loc.tenant_id=assignment.tenant_id
                AND loc.id=assignment.location_id
              WHERE assignment.tenant_id=$1::uuid
                AND assignment.location_id=$2::uuid
                AND assignment.staff_id=$3::uuid
                AND assignment.active AND staff.active`,
            [actor.tenantId, locationId, staffId],
          );
          const current = staff.rows[0];
          if (!current?.time_zone) return null;
          const shifts = await client.query<IntervalRow>(
            `SELECT start_at, end_at
               FROM cookie_scheduling.shift_windows
              WHERE tenant_id=$1::uuid AND location_id=$2::uuid
                AND staff_id=$3::uuid AND active
                AND start_at < $5::timestamptz
                AND end_at > $4::timestamptz
              ORDER BY start_at, id LIMIT 501`,
            [actor.tenantId, locationId, staffId, from, to],
          );
          const blocked = await client.query<BlockedRow>(
            `SELECT kind, start_at, end_at
               FROM cookie_scheduling.blocked_windows
              WHERE tenant_id=$1::uuid AND location_id=$2::uuid
                AND staff_id=$3::uuid AND active
                AND start_at < $5::timestamptz
                AND end_at > $4::timestamptz
              ORDER BY start_at, id LIMIT 501`,
            [actor.tenantId, locationId, staffId, from, to],
          );
          if (shifts.rows.length > 500 || blocked.rows.length > 500) {
            throw new Error("Synthetic schedule exceeds bounded read");
          }
          return {
            locationId,
            staffId,
            staffName: current.staff_name,
            timeZone: current.time_zone,
            shifts: shifts.rows.map(range),
            blocked: blocked.rows.map((row) => ({
              kind: row.kind,
              ...range(row),
            })),
          };
        });
        if (!schedule) return errorReply(reply, 404, "STAFF_NOT_FOUND");
        return reply.send(schedule);
      } catch (error) {
        return handleFailure(error, reply);
      }
    },
  );
}
