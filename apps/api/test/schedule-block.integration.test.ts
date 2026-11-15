import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import {
  addScheduleBlockInternal,
  type InternalAddScheduleBlock,
} from "../../../packages/domain-scheduling/src/block.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "protected schedule blocks serialize with bookings and cannot invalidate confirmed visits",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-schedule-block-test",
      max: 8,
    });
    const owner = randomUUID();
    const outsider = randomUUID();
    const tenant = randomUUID();
    const otherTenant = randomUUID();
    const locationA = randomUUID();
    const locationB = randomUUID();
    const staff = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const role = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-block-command",
    };
    const base: InternalAddScheduleBlock = {
      actor,
      staffId: staff,
      locationId: locationA,
      kind: "break",
      startAt: "2027-04-12T14:00:00Z",
      endAt: "2027-04-12T15:00:00Z",
      idempotencyKey: "block-afternoon-a",
    };
    const entitled = async (): Promise<void> => undefined;
    const booking = (key: string, startAt: string, locationId = locationA) =>
      createBookingInternal(
        pool,
        {
          actor,
          customerId: customer,
          locationId,
          staffId: staff,
          serviceId: service,
          startAt,
          idempotencyKey: key,
        },
        entitled,
      );
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid),($2::uuid)",
        [owner, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'Synthetic schedules A'),
                ($2::uuid,$3::uuid,'Synthetic schedules B')`,
        [tenant, otherTenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'A','UTC'),
                ($1::uuid,$3::uuid,'B','UTC')`,
        [tenant, locationA, locationB],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid)`,
        [tenant, owner, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions)
         VALUES ($1::uuid,$2::uuid,'owner','Synthetic owner',
                 ARRAY['booking.create','schedule.manage'])`,
        [tenant, role],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        [tenant, randomUUID(), owner, role],
      );
      await pool.query(
        "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1::uuid,$2::uuid)",
        [tenant, customer],
      );
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,
            post_service_buffer_minutes,base_price_kopecks,active)
         VALUES ($1::uuid,$2::uuid,'Synthetic service',60,10,10000,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
           (tenant_id,id,display_name,active,bookable)
         VALUES ($1::uuid,$2::uuid,'Synthetic staff',true,true)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,true),
                ($1::uuid,$2::uuid,$4::uuid,true)`,
        [tenant, staff, locationA, locationB],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$5::uuid,true),
                ($1::uuid,$2::uuid,$4::uuid,$5::uuid,true)`,
        [tenant, staff, locationA, locationB, service],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,
                 '2027-04-12T09:00:00Z','2027-04-12T21:00:00Z',true),
                ($1::uuid,$5::uuid,$3::uuid,$6::uuid,
                 '2027-04-12T09:00:00Z','2027-04-12T21:00:00Z',true)`,
        [tenant, randomUUID(), staff, locationA, randomUUID(), locationB],
      );

      const first = await booking("original-booking", "2027-04-12T10:00:00Z");
      assert.equal(first.status, "Confirmed");
      await assert.rejects(
        addScheduleBlockInternal(pool, {
          ...base,
          startAt: "2027-04-12T11:00:00Z",
          endAt: "2027-04-12T11:05:00Z",
          idempotencyKey: "overlaps-original-post-buffer",
        }),
        { code: "SCHEDULE_BOOKING_CONFLICT" },
        "buffered Confirmed appointment is not silently invalidated",
      );

      // A block at B does not invalidate an appointment in A. The customer's
      // existing B booking rules still consider tenant-wide staff occupancy.
      const locationBBlock = await addScheduleBlockInternal(pool, {
        ...base,
        locationId: locationB,
        startAt: "2027-04-12T10:30:00Z",
        endAt: "2027-04-12T10:45:00Z",
        idempotencyKey: "location-b-independent-block",
      });
      assert.equal(locationBBlock.locationId, locationB);

      await assert.rejects(
        addScheduleBlockInternal(pool, {
          ...base,
          actor: { ...actor, identityId: outsider },
        }),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        addScheduleBlockInternal(pool, {
          ...base,
          actor: { ...actor, tenantId: otherTenant },
        }),
        { code: "SCHEDULE_TARGET_UNAVAILABLE" },
      );
      await assert.rejects(
        addScheduleBlockInternal(pool, { ...base, startAt: "2026-01-01T00:00:00Z" }),
        { code: "INVALID_SCHEDULE_BLOCK" },
      );
      await assert.rejects(
        addScheduleBlockInternal(pool, {
          ...base,
          endAt: "2027-04-12T14:00:00Z",
        }),
        { code: "INVALID_SCHEDULE_BLOCK" },
      );
      await assert.rejects(
        addScheduleBlockInternal(pool, {
          ...base,
          idempotencyKey: "unknown-location",
          locationId: randomUUID(),
        }),
        { code: "SCHEDULE_TARGET_UNAVAILABLE" },
      );

      const [created, repeated] = await Promise.all([
        addScheduleBlockInternal(pool, base),
        addScheduleBlockInternal(pool, base),
      ]);
      assert.deepEqual(repeated, created);
      assert.equal(created.active, true);
      assert.equal(created.kind, "break");
      assert.deepEqual([created.startAt, created.endAt], [
        "2027-04-12T14:00:00.000Z",
        "2027-04-12T15:00:00.000Z",
      ]);
      await assert.rejects(
        addScheduleBlockInternal(pool, {
          ...base,
          endAt: "2027-04-12T15:30:00Z",
        }),
        { code: "SCHEDULE_KEY_REUSED" },
      );
      const persisted = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM cookie_scheduling.blocked_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, created.id],
      );
      assert.equal(persisted.rows[0]?.count, "1");

      await assert.rejects(
        booking("book-inside-break", "2027-04-12T14:10:00Z"),
        { code: "BOOKING_NOT_AVAILABLE" },
      );
      const afterBreak = await booking("book-after-break", "2027-04-12T15:00:00Z");
      assert.equal(afterBreak.status, "Confirmed");

      // A racing block and booking must not both commit an overlapping time.
      const race = await Promise.allSettled([
        addScheduleBlockInternal(pool, {
          ...base,
          kind: "exception",
          startAt: "2027-04-12T18:30:00Z",
          endAt: "2027-04-12T18:50:00Z",
          idempotencyKey: "concurrent-exception",
        }),
        booking("concurrent-booking", "2027-04-12T18:00:00Z"),
      ]);
      assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(race.filter((x) => x.status === "rejected").length, 1);

      const saved = await pool.query<{
        confirmed: string;
        blocks: string;
        original_start_at: Date;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_booking.bookings
            WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed,
          (SELECT count(*)::text FROM cookie_scheduling.blocked_windows
            WHERE tenant_id=$1::uuid AND active) AS blocks,
          (SELECT start_at FROM cookie_booking.bookings
            WHERE tenant_id=$1::uuid AND id=$2::uuid) AS original_start_at`,
        [tenant, first.bookingId],
      );
      assert.equal(saved.rows[0]?.original_start_at.toISOString(), first.startAt);
      assert.equal(saved.rows[0]?.confirmed === "2" || saved.rows[0]?.confirmed === "3", true);
      assert.equal(saved.rows[0]?.blocks === "2" || saved.rows[0]?.blocks === "3", true);
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
          await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1::uuid`, [tenant]);
        }
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=ANY($1::uuid[])",
          [[tenant, otherTenant]],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [[owner, outsider]],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
