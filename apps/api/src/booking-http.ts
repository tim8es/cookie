import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  CreateBookingFailure,
  createBookingInternal,
  type AssertBookingEntitlement,
} from "../../../packages/domain-booking/src/create.js";
import { listAvailableSlots } from "../../../packages/domain-scheduling/src/index.js";
import {
  AuthorizationDeniedError,
  type TrustedActor,
} from "../../../packages/platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../../packages/platform-identity/src/postgres.js";
import {
  type BearerSessionVerifier,
  verifyTenantActor,
} from "./session-context.js";

/**
 * An intentionally opt-in F1 staff-assisted API. No verifier, entitlement or
 * customer ownership provider is supplied by production main.ts. Only a
 * synthetic harness may mount this until the missing AuthN/entitlement gates
 * are implemented; never infer customer ownership from a customerId in JSON.
 */
export interface SyntheticBookingHttpDependencies {
  readonly pool: Pool;
  readonly verifier: BearerSessionVerifier;
  readonly assertEntitled: AssertBookingEntitlement;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type TenantParams = { tenantId: string };
type LocationParams = TenantParams & { locationId: string };
type BookingParams = TenantParams & { bookingId: string };
type CatalogOffer = {
  serviceId: string;
  serviceName: string;
  staffId: string;
  staffName: string;
  durationMinutes: number;
  postServiceBufferMinutes: number;
  priceKopecks: string;
  timeZone: string;
};
type CreateBody = {
  customerId: string;
  locationId: string;
  staffId: string;
  serviceId: string;
  startAt: string;
};
type BookingReadRow = QueryResultRow & {
  id: string;
  customer_id: string;
  location_id: string;
  staff_id: string;
  service_id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  occupied_until: Date;
  price_kopecks_snapshot: string;
};

function fail(
  reply: { code(status: number): { send(value: unknown): unknown } },
  status: number,
  code: string,
): unknown {
  return reply.code(status).send({ error: { code } });
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_INSTANT.test(value)) return false;
  const ms = Date.parse(value);
  return (
    Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const ms = Date.parse(value + "T00:00:00Z");
  return (
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
  );
}

function validCreateBody(body: unknown): body is CreateBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  const allowed = [
    "customerId",
    "locationId",
    "staffId",
    "serviceId",
    "startAt",
  ];
  return (
    Object.keys(fields).length === allowed.length &&
    Object.keys(fields).every((key) => allowed.includes(key)) &&
    allowed
      .slice(0, 4)
      .every(
        (key) =>
          typeof fields[key] === "string" && UUID.test(fields[key] as string),
      ) &&
    typeof fields.startAt === "string" &&
    UTC_MINUTE.test(fields.startAt) &&
    validInstant(fields.startAt)
  );
}

async function inReadTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;
    const result = await action(client);
    await client.query("COMMIT");
    active = false;
    return result;
  } catch (error) {
    if (active) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function bookingDto(row: BookingReadRow) {
  return {
    bookingId: row.id,
    customerId: row.customer_id,
    locationId: row.location_id,
    staffId: row.staff_id,
    serviceId: row.service_id,
    status: row.status,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    occupiedUntil: row.occupied_until.toISOString(),
    priceKopecks: row.price_kopecks_snapshot,
  };
}

const BOOKING_SELECT = `SELECT id::text, customer_id::text, location_id::text,
  staff_id::text, service_id::text, status, start_at, end_at, occupied_until,
  price_kopecks_snapshot::text
  FROM cookie_booking.bookings`;

export function registerSyntheticBookingHttp(
  app: FastifyInstance,
  dependencies: SyntheticBookingHttpDependencies,
): void {
  const { pool, verifier, assertEntitled } = dependencies;

  async function authenticate(
    authorization: string | undefined,
    tenantId: string,
    reply: { code(status: number): { send(value: unknown): unknown } },
  ): Promise<TrustedActor | null> {
    const verified = await verifyTenantActor(authorization, tenantId, verifier);
    if (!verified.actor) {
      fail(
        reply,
        verified.status,
        verified.error === "forbidden" ? "ACCESS_DENIED" : "UNAUTHENTICATED",
      );
      return null;
    }
    return verified.actor;
  }

  function handleFailure(
    error: unknown,
    reply: { code(status: number): { send(value: unknown): unknown } },
  ): unknown {
    if (error instanceof AuthorizationDeniedError)
      return fail(reply, 403, "ACCESS_DENIED");
    if (error instanceof CreateBookingFailure) {
      if (
        error.code === "BOOKING_CONFLICT" ||
        error.code === "BOOKING_NOT_AVAILABLE"
      )
        return fail(reply, 409, "BOOKING_CONFLICT");
      if (error.code === "IDEMPOTENCY_KEY_REUSED")
        return fail(reply, 409, "IDEMPOTENCY_KEY_REUSED");
      return fail(reply, 400, "INVALID_BOOKING_COMMAND");
    }
    // Never expose SQL errors, connection strings, token information or PII.
    return fail(reply, 503, "BACKEND_UNAVAILABLE");
  }

  app.get<{ Params: LocationParams }>(
    "/v1/organizations/:tenantId/locations/:locationId/catalog",
    async (request, reply) => {
      const actor = await authenticate(
        request.headers.authorization,
        request.params.tenantId,
        reply,
      );
      if (!actor) return reply;
      if (!UUID.test(request.params.locationId))
        return fail(reply, 400, "INVALID_REQUEST");
      try {
        const offers = await inReadTransaction(pool, async (client) => {
          await requireTenantPermission(
            client,
            actor,
            {
              kind: "organization",
              tenantId: actor.tenantId,
              locationId: request.params.locationId,
            },
            "booking.create",
          );
          const rows = await client.query<{
            service_id: string;
            service_name: string;
            staff_id: string;
            staff_name: string;
            duration_minutes: number;
            post_service_buffer_minutes: number;
            price_kopecks: string;
            time_zone: string | null;
          }>(
            `SELECT service.id::text AS service_id, service.display_name AS service_name,
                    staff.id::text AS staff_id, staff.display_name AS staff_name,
                    service.duration_minutes, service.post_service_buffer_minutes,
                    service.base_price_kopecks::text AS price_kopecks, loc.time_zone
              FROM cookie_staff.service_assignments assignment
              JOIN cookie_staff.location_assignments staff_loc
                ON staff_loc.tenant_id=assignment.tenant_id
               AND staff_loc.staff_id=assignment.staff_id
               AND staff_loc.location_id=assignment.location_id
              JOIN cookie_staff.staff_profiles staff
                ON staff.tenant_id=assignment.tenant_id AND staff.id=assignment.staff_id
              JOIN cookie_catalog.services service
                ON service.tenant_id=assignment.tenant_id AND service.id=assignment.service_id
              JOIN cookie_tenancy.locations loc
                ON loc.tenant_id=assignment.tenant_id AND loc.id=assignment.location_id
             WHERE assignment.tenant_id=$1::uuid AND assignment.location_id=$2::uuid
               AND assignment.active AND staff_loc.active AND staff.active
               AND staff.bookable AND service.active AND loc.time_zone IS NOT NULL
             ORDER BY service.display_name, staff.display_name, service.id, staff.id`,
            [actor.tenantId, request.params.locationId],
          );
          return rows.rows.map(
            (row): CatalogOffer => ({
              serviceId: row.service_id,
              serviceName: row.service_name,
              staffId: row.staff_id,
              staffName: row.staff_name,
              durationMinutes: row.duration_minutes,
              postServiceBufferMinutes: row.post_service_buffer_minutes,
              priceKopecks: row.price_kopecks,
              timeZone: row.time_zone!,
            }),
          );
        });
        return reply.send({ offers });
      } catch (error) {
        return handleFailure(error, reply);
      }
    },
  );

  app.get<{
    Params: LocationParams;
    Querystring: { serviceId?: string; staffId?: string; date?: string };
  }>(
    "/v1/organizations/:tenantId/locations/:locationId/availability",
    async (request, reply) => {
      const actor = await authenticate(
        request.headers.authorization,
        request.params.tenantId,
        reply,
      );
      if (!actor) return reply;
      const { locationId } = request.params;
      const { serviceId, staffId, date } = request.query;
      if (
        !UUID.test(locationId) ||
        !serviceId ||
        !UUID.test(serviceId) ||
        !staffId ||
        !UUID.test(staffId) ||
        !validDate(date)
      )
        return fail(reply, 400, "INVALID_REQUEST");
      try {
        const availability = await inReadTransaction(pool, async (client) => {
          await requireTenantPermission(
            client,
            actor,
            {
              kind: "booking",
              tenantId: actor.tenantId,
              locationId,
              staffProfileId: staffId,
            },
            "booking.create",
          );
          const service = await client.query<{
            duration_minutes: number;
            post_service_buffer_minutes: number;
            price_kopecks: string;
            time_zone: string;
          }>(
            `SELECT service.duration_minutes, service.post_service_buffer_minutes,
                    service.base_price_kopecks::text AS price_kopecks, loc.time_zone
               FROM cookie_staff.service_assignments assignment
               JOIN cookie_staff.location_assignments staff_loc
                 ON staff_loc.tenant_id=assignment.tenant_id
                AND staff_loc.location_id=assignment.location_id
                AND staff_loc.staff_id=assignment.staff_id
               JOIN cookie_staff.staff_profiles staff
                 ON staff.tenant_id=assignment.tenant_id AND staff.id=assignment.staff_id
               JOIN cookie_catalog.services service
                 ON service.tenant_id=assignment.tenant_id AND service.id=assignment.service_id
               JOIN cookie_tenancy.locations loc
                 ON loc.tenant_id=assignment.tenant_id AND loc.id=assignment.location_id
              WHERE assignment.tenant_id=$1::uuid AND assignment.location_id=$2::uuid
                AND assignment.staff_id=$3::uuid AND assignment.service_id=$4::uuid
                AND assignment.active AND staff_loc.active AND staff.active
                AND staff.bookable AND service.active AND loc.time_zone IS NOT NULL`,
            [actor.tenantId, locationId, staffId, serviceId],
          );
          const settings = service.rows[0];
          if (!settings) return { slots: [], priceKopecks: null };
          const shifts = await client.query<{ start_at: Date; end_at: Date }>(
            `SELECT start_at, end_at FROM cookie_scheduling.shift_windows
              WHERE tenant_id=$1::uuid AND location_id=$2::uuid
                AND staff_id=$3::uuid AND active`,
            [actor.tenantId, locationId, staffId],
          );
          const blocked = await client.query<{
            start_at: Date;
            end_at: Date;
            kind: string;
          }>(
            `SELECT start_at, end_at, kind FROM cookie_scheduling.blocked_windows
              WHERE tenant_id=$1::uuid AND location_id=$2::uuid
                AND staff_id=$3::uuid AND active`,
            [actor.tenantId, locationId, staffId],
          );
          const occupied = await client.query<{
            location_id: string;
            start_at: Date;
            occupied_until: Date;
          }>(
            `SELECT location_id::text, start_at, occupied_until
               FROM cookie_booking.bookings
              WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
                AND status='Confirmed'`,
            [actor.tenantId, staffId],
          );
          const intervals = (rows: { start_at: Date; end_at: Date }[]) =>
            rows.map((row) => ({
              startAt: row.start_at.toISOString(),
              endAt: row.end_at.toISOString(),
            }));
          const available = listAvailableSlots({
            organizationId: actor.tenantId,
            locationId,
            staffId,
            localDate: date,
            timeZone: settings.time_zone,
            serviceDurationMinutes: settings.duration_minutes,
            postServiceBufferMinutes: settings.post_service_buffer_minutes,
            stepMinutes: 1,
            shifts: intervals(shifts.rows),
            breaks: intervals(
              blocked.rows.filter((row) => row.kind === "break"),
            ),
            exceptions: intervals(
              blocked.rows.filter((row) => row.kind === "exception"),
            ),
            occupied: occupied.rows.map((row) => ({
              organizationId: actor.tenantId,
              locationId: row.location_id,
              staffId,
              startAt: row.start_at.toISOString(),
              occupiedUntil: row.occupied_until.toISOString(),
            })),
          });
          return {
            priceKopecks: settings.price_kopecks,
            slots: available.filter(
              (slot) => Date.parse(slot.startAt) > Date.now(),
            ),
          };
        });
        return reply.send(availability);
      } catch (error) {
        return handleFailure(error, reply);
      }
    },
  );

  app.post<{ Params: TenantParams; Body: CreateBody }>(
    "/v1/organizations/:tenantId/bookings",
    async (request, reply) => {
      const actor = await authenticate(
        request.headers.authorization,
        request.params.tenantId,
        reply,
      );
      if (!actor) return reply;
      const key = request.headers["idempotency-key"];
      if (
        !validCreateBody(request.body) ||
        typeof key !== "string" ||
        key.length < 1 ||
        key.length > 128
      )
        return fail(reply, 400, "INVALID_REQUEST");
      try {
        const receipt = await createBookingInternal(
          pool,
          {
            actor,
            customerId: request.body.customerId,
            locationId: request.body.locationId,
            staffId: request.body.staffId,
            serviceId: request.body.serviceId,
            startAt: request.body.startAt,
            idempotencyKey: key,
          },
          assertEntitled,
        );
        return reply.code(201).send(receipt);
      } catch (error) {
        return handleFailure(error, reply);
      }
    },
  );

  app.get<{ Params: BookingParams }>(
    "/v1/organizations/:tenantId/bookings/:bookingId",
    async (request, reply) => {
      const actor = await authenticate(
        request.headers.authorization,
        request.params.tenantId,
        reply,
      );
      if (!actor) return reply;
      if (!UUID.test(request.params.bookingId))
        return fail(reply, 400, "INVALID_REQUEST");
      try {
        const booking = await inReadTransaction(pool, async (client) => {
          const rows = await client.query<BookingReadRow>(
            BOOKING_SELECT + " WHERE tenant_id=$1::uuid AND id=$2::uuid",
            [actor.tenantId, request.params.bookingId],
          );
          const row = rows.rows[0];
          if (!row) return null;
          await requireTenantPermission(
            client,
            actor,
            {
              kind: "booking",
              tenantId: actor.tenantId,
              locationId: row.location_id,
              staffProfileId: row.staff_id,
            },
            "booking.read",
          );
          return bookingDto(row);
        });
        if (!booking) return fail(reply, 404, "BOOKING_NOT_FOUND");
        return reply.send(booking);
      } catch (error) {
        return handleFailure(error, reply);
      }
    },
  );

  app.get<{
    Params: LocationParams;
    Querystring: { from?: string; to?: string };
  }>(
    "/v1/organizations/:tenantId/locations/:locationId/calendar",
    async (request, reply) => {
      const actor = await authenticate(
        request.headers.authorization,
        request.params.tenantId,
        reply,
      );
      if (!actor) return reply;
      const { locationId } = request.params;
      const { from, to } = request.query;
      if (
        !UUID.test(locationId) ||
        !validInstant(from) ||
        !validInstant(to) ||
        Date.parse(to) <= Date.parse(from) ||
        Date.parse(to) - Date.parse(from) > 7 * 86_400_000
      )
        return fail(reply, 400, "INVALID_REQUEST");
      try {
        const bookings = await inReadTransaction(pool, async (client) => {
          await requireTenantPermission(
            client,
            actor,
            { kind: "organization", tenantId: actor.tenantId, locationId },
            "booking.read",
          );
          const rows = await client.query<BookingReadRow>(
            BOOKING_SELECT +
              ` WHERE tenant_id=$1::uuid AND location_id=$2::uuid
                   AND start_at >= $3::timestamptz AND start_at < $4::timestamptz
                 ORDER BY start_at, id LIMIT 201`,
            [actor.tenantId, locationId, from, to],
          );
          if (rows.rows.length > 200)
            throw new Error("Calendar result exceeds bounded F1 page");
          return rows.rows.map(bookingDto);
        });
        return reply.send({ bookings });
      } catch (error) {
        return handleFailure(error, reply);
      }
    },
  );
}
