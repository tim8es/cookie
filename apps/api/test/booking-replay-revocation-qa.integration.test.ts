import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { cancelBookingInternal } from "../../../packages/domain-booking/src/cancel.js";
import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { rescheduleBookingInternal } from "../../../packages/domain-booking/src/reschedule.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface BookingState {
  readonly status: string;
  readonly startAt: Date;
  readonly price: string;
  readonly receipts: string;
  readonly events: string;
  readonly moveAudit: string;
  readonly cancelAudit: string;
}

async function state(
  pool: Pool,
  tenantId: string,
  bookingId: string,
): Promise<BookingState> {
  const rows = await pool.query<BookingState>(
    `SELECT
       (SELECT status FROM cookie_booking.bookings
         WHERE tenant_id=$1::uuid AND id=$2::uuid) AS status,
       (SELECT start_at FROM cookie_booking.bookings
         WHERE tenant_id=$1::uuid AND id=$2::uuid) AS "startAt",
       (SELECT price_kopecks_snapshot::text FROM cookie_booking.bookings
         WHERE tenant_id=$1::uuid AND id=$2::uuid) AS price,
       (SELECT count(*)::text FROM cookie_booking.command_receipts
         WHERE tenant_id=$1::uuid) AS receipts,
       (SELECT count(*)::text FROM cookie_jobs.outbox_events
         WHERE tenant_id=$1::uuid) AS events,
       (SELECT count(*)::text FROM cookie_booking.time_change_audit
         WHERE tenant_id=$1::uuid) AS "moveAudit",
       (SELECT count(*)::text FROM cookie_booking.booking_state_audit
         WHERE tenant_id=$1::uuid) AS "cancelAudit"`,
    [tenantId, bookingId],
  );
  assert.ok(rows.rows[0]);
  return rows.rows[0];
}

test(
  "current tenant permissions gate replay of committed Create, Reschedule and CancelBooking",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-booking-replay-revocation",
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const role = randomUUID();
    const assignment = randomUUID();
    const location = randomUUID();
    const staff = randomUUID();
    const customer = randomUUID();
    const service = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-booking-replay-revocation",
    };
    const create = {
      actor,
      customerId: customer,
      locationId: location,
      staffId: staff,
      serviceId: service,
      startAt: "2028-09-20T10:00:00Z",
      idempotencyKey: "qa-revocation-create",
    };
    const allow = async (): Promise<void> => undefined;
    const denyCallback = async (): Promise<void> => {
      throw new Error("replay must not re-execute entitlement or policy");
    };
    const toggle = async (
      table: "memberships" | "roles" | "role_assignments",
      keyColumn: "identity_id" | "id",
      key: string,
      active: boolean,
    ): Promise<void> => {
      await pool.query(
        "UPDATE cookie_identity." +
          table +
          " SET active=$3 WHERE tenant_id=$1::uuid AND " +
          keyColumn +
          "=$2::uuid",
        [tenant, key, active],
      );
    };

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES ($1::uuid,$2::uuid,'Synthetic booking replay QA')`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations
           (tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'QA branch','UTC')`,
        [tenant, location],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES ($1::uuid,$2::uuid,'owner','QA owner',
                 ARRAY['booking.create','booking.reschedule','booking.cancel'])`,
        [tenant, role],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        [tenant, assignment, owner, role],
      );
      await pool.query(
        `INSERT INTO cookie_customers.customers(tenant_id,id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenant, customer],
      );
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,
            post_service_buffer_minutes,base_price_kopecks,active)
         VALUES ($1::uuid,$2::uuid,'QA service',60,10,125000,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
           (tenant_id,id,display_name,active,bookable)
         VALUES ($1::uuid,$2::uuid,'QA staff',true,true)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,true)`,
        [tenant, staff, location],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true)`,
        [tenant, staff, location, service],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,
                 '2028-09-20T09:00:00Z','2028-09-20T18:00:00Z',true)`,
        [tenant, randomUUID(), staff, location],
      );

      const created = await createBookingInternal(pool, create, allow);
      assert.equal(created.status, "Confirmed");
      assert.equal(created.priceKopecks, "125000");
      const afterCreate = await state(pool, tenant, created.bookingId);
      assert.equal(afterCreate.receipts, "1");
      assert.equal(afterCreate.events, "1");
      await toggle("memberships", "identity_id", owner, false);
      await assert.rejects(
        createBookingInternal(pool, create, denyCallback),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        createBookingInternal(
          pool,
          { ...create, startAt: "2028-09-20T14:00:00Z" },
          denyCallback,
        ),
        { code: "ACCESS_DENIED" },
      );
      assert.deepEqual(await state(pool, tenant, created.bookingId), afterCreate);
      await toggle("memberships", "identity_id", owner, true);
      assert.deepEqual(
        await createBookingInternal(pool, create, denyCallback),
        created,
      );
      assert.deepEqual(await state(pool, tenant, created.bookingId), afterCreate);

      const move = {
        actor,
        bookingId: created.bookingId,
        newStartAt: "2028-09-20T13:00:00Z",
        idempotencyKey: "qa-revocation-reschedule",
      };
      const moved = await rescheduleBookingInternal(pool, move, allow);
      assert.equal(moved.status, "Confirmed");
      assert.equal(moved.startAt, "2028-09-20T13:00:00.000Z");
      const afterMove = await state(pool, tenant, created.bookingId);
      assert.deepEqual(
        [afterMove.receipts, afterMove.events, afterMove.moveAudit],
        ["2", "2", "1"],
      );
      assert.equal(afterMove.price, afterCreate.price);
      await toggle("roles", "id", role, false);
      await assert.rejects(
        rescheduleBookingInternal(pool, move, denyCallback),
        { code: "ACCESS_DENIED" },
      );
      assert.deepEqual(await state(pool, tenant, created.bookingId), afterMove);
      await toggle("roles", "id", role, true);
      assert.deepEqual(
        await rescheduleBookingInternal(pool, move, denyCallback),
        moved,
      );
      await assert.rejects(
        rescheduleBookingInternal(
          pool,
          { ...move, newStartAt: "2028-09-20T14:00:00Z" },
          denyCallback,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );
      assert.deepEqual(await state(pool, tenant, created.bookingId), afterMove);

      const cancel = {
        actor,
        bookingId: created.bookingId,
        idempotencyKey: "qa-revocation-cancel",
      };
      const cancelled = await cancelBookingInternal(pool, cancel, allow);
      assert.equal(cancelled.status, "CancelledByBusiness");
      const afterCancel = await state(pool, tenant, created.bookingId);
      assert.deepEqual(
        [
          afterCancel.status,
          afterCancel.receipts,
          afterCancel.events,
          afterCancel.cancelAudit,
        ],
        ["CancelledByBusiness", "3", "3", "1"],
      );
      await toggle("role_assignments", "id", assignment, false);
      await assert.rejects(
        cancelBookingInternal(pool, cancel, denyCallback),
        { code: "ACCESS_DENIED" },
      );
      assert.deepEqual(await state(pool, tenant, created.bookingId), afterCancel);
      await toggle("role_assignments", "id", assignment, true);
      assert.deepEqual(
        await cancelBookingInternal(pool, cancel, denyCallback),
        cancelled,
      );
      assert.deepEqual(await state(pool, tenant, created.bookingId), afterCancel);

      // Historical idempotent create result is returned without reactivating
      // a cancelled booking or generating new Outbox side effects.
      assert.deepEqual(
        await createBookingInternal(pool, create, denyCallback),
        created,
      );
      assert.deepEqual(await state(pool, tenant, created.bookingId), afterCancel);
    } finally {
      const tables = [
        "cookie_booking.time_change_audit",
        "cookie_booking.booking_state_audit",
        "cookie_booking.command_receipts",
        "cookie_jobs.outbox_replay_audit",
        "cookie_jobs.outbox_events",
        "cookie_booking.bookings",
        "cookie_identity.authorization_audit",
        "cookie_scheduling.blocked_windows",
        "cookie_scheduling.shift_windows",
        "cookie_staff.service_assignments",
        "cookie_staff.location_assignments",
        "cookie_staff.staff_profiles",
        "cookie_catalog.services",
        "cookie_customers.customers",
        "cookie_identity.role_assignments",
        "cookie_identity.roles",
        "cookie_identity.memberships",
        "cookie_tenancy.locations",
      ];
      try {
        for (const table of tables) {
          await pool
            .query("DELETE FROM " + table + " WHERE tenant_id=$1::uuid", [
              tenant,
            ])
            .catch(() => undefined);
        }
        await pool
          .query(
            "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
            [tenant],
          )
          .catch(() => undefined);
        await pool
          .query("DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [
            owner,
          ])
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
