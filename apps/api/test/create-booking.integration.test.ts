import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  createBookingInternal,
  type InternalCreateBooking,
} from "../../../packages/domain-booking/src/create.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "internal CreateBooking commits once with idempotency, staff isolation and outbox",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-create-booking-integration",
      max: 8,
    });
    const owner = randomUUID();
    const outsider = randomUUID();
    const tenant = randomUUID();
    const staff = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const locationA = randomUUID();
    const locationB = randomUUID();
    const role = randomUUID();
    const assignment = randomUUID();
    const actor = {
      identityId: owner,
      tenantId: tenant,
      correlationId: "f1-test-create-booking",
    };
    const command: InternalCreateBooking = {
      actor,
      customerId: customer,
      staffId: staff,
      serviceId: service,
      locationId: locationA,
      startAt: "2027-04-12T10:00:00Z",
      idempotencyKey: "same-operator-request",
    };

    let entitlementChecks = 0;
    const allowSyntheticEntitlement = async (): Promise<void> => {
      entitlementChecks++;
    };

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1),($2)",
        [owner, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
         VALUES($1,$2,'Synthetic guarded booking')`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES($1,$2,'A','UTC'),($1,$3,'B','UTC')`,
        [tenant, locationA, locationB],
      );
      await pool.query(
        "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1,$2)",
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES($1,$2,'owner','Synthetic owner',ARRAY['booking.create'])`,
        [tenant, role],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES($1,$2,$3,$4)`,
        [tenant, assignment, owner, role],
      );
      await pool.query(
        `INSERT INTO cookie_customers.customers(tenant_id,id)
         VALUES($1,$2)`,
        [tenant, customer],
      );
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,
            post_service_buffer_minutes,base_price_kopecks,active)
         VALUES($1,$2,'Haircut',60,10,150000,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
           (tenant_id,id,display_name,active,bookable)
         VALUES($1,$2,'Staff',true,true)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES($1,$2,$3,true),($1,$2,$4,true)`,
        [tenant, staff, locationA, locationB],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES($1,$2,$3,$5,true),($1,$2,$4,$5,true)`,
        [tenant, staff, locationA, locationB, service],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1,$2,$3,$4,'2027-04-12T09:00:00Z','2027-04-12T18:00:00Z',true),
                ($1,$5,$3,$6,'2027-04-12T09:00:00Z','2027-04-12T18:00:00Z',true)`,
        [tenant, randomUUID(), staff, locationA, randomUUID(), locationB],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.blocked_windows
           (tenant_id,id,staff_id,location_id,kind,start_at,end_at,active)
         VALUES ($1,$2,$3,$4,'break','2027-04-12T12:00:00Z',
                 '2027-04-12T13:00:00Z',true)`,
        [tenant, randomUUID(), staff, locationA],
      );

      // Concurrent retries of the exact same command must return one receipt.
      const [first, replay] = await Promise.all([
        createBookingInternal(pool, command, allowSyntheticEntitlement),
        createBookingInternal(pool, command, allowSyntheticEntitlement),
      ]);
      assert.deepEqual(replay, first);
      assert.equal(first.status, "Confirmed");
      assert.equal(first.startAt, "2027-04-12T10:00:00.000Z");
      assert.equal(first.endAt, "2027-04-12T11:00:00.000Z");
      assert.equal(first.occupiedUntil, "2027-04-12T11:10:00.000Z");
      assert.equal(first.priceKopecks, "150000");
      assert.equal(
        entitlementChecks,
        1,
        "a replay must not create another booking",
      );

      const counts = await pool.query<{
        bookings: string;
        receipts: string;
        events: string;
      }>(
        `SELECT
          (SELECT count(*) FROM cookie_booking.bookings WHERE tenant_id=$1)::text AS bookings,
          (SELECT count(*) FROM cookie_booking.command_receipts WHERE tenant_id=$1)::text AS receipts,
          (SELECT count(*) FROM cookie_jobs.outbox_events WHERE tenant_id=$1)::text AS events`,
        [tenant],
      );
      assert.deepEqual(counts.rows[0], {
        bookings: "1",
        receipts: "1",
        events: "1",
      });

      // The same key is bound to its ORIGINAL request, even after success.
      await assert.rejects(
        createBookingInternal(
          pool,
          { ...command, startAt: "2027-04-12T14:00:00Z" },
          allowSyntheticEntitlement,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );
      // A new key must re-check occupied staff time in the OTHER branch.
      await assert.rejects(
        createBookingInternal(
          pool,
          {
            ...command,
            locationId: locationB,
            startAt: "2027-04-12T10:05:00Z",
            idempotencyKey: "other-branch-overlap",
          },
          allowSyntheticEntitlement,
        ),
        { code: "BOOKING_NOT_AVAILABLE" },
      );
      await assert.rejects(
        createBookingInternal(
          pool,
          {
            ...command,
            startAt: "2027-04-12T11:30:00Z",
            idempotencyKey: "break-overlap",
          },
          allowSyntheticEntitlement,
        ),
        { code: "BOOKING_NOT_AVAILABLE" },
      );

      // Unauthenticated/unassigned identity cannot pass the permission guard.
      await assert.rejects(
        createBookingInternal(
          pool,
          {
            ...command,
            actor: { ...actor, identityId: outsider },
            startAt: "2027-04-12T14:00:00Z",
            idempotencyKey: "outsider",
          },
          allowSyntheticEntitlement,
        ),
        { code: "ACCESS_DENIED" },
      );
      // No default commercial entitlement is wired: explicit denial rolls
      // back all data and leaves the key reusable after a legitimate upgrade.
      await assert.rejects(
        createBookingInternal(
          pool,
          {
            ...command,
            startAt: "2027-04-12T14:00:00Z",
            idempotencyKey: "entitlement-denied",
          },
          async () => {
            throw new Error("TRIAL_EXPIRED");
          },
        ),
        /TRIAL_EXPIRED/,
      );

      await pool.query(
        `UPDATE cookie_catalog.services SET base_price_kopecks=159900
         WHERE tenant_id=$1 AND id=$2`,
        [tenant, service],
      );
      const repeatedAfterChange = await createBookingInternal(
        pool,
        command,
        allowSyntheticEntitlement,
      );
      assert.deepEqual(repeatedAfterChange, first);
      const secondBooking = await createBookingInternal(
        pool,
        {
          ...command,
          startAt: "2027-04-12T14:00:00Z",
          idempotencyKey: "entitlement-denied",
        },
        allowSyntheticEntitlement,
      );
      assert.equal(secondBooking.priceKopecks, "159900");
      assert.notEqual(secondBooking.bookingId, first.bookingId);

      const final = await pool.query<{
        bookings: string;
        receipts: string;
        events: string;
      }>(
        `SELECT
          (SELECT count(*) FROM cookie_booking.bookings WHERE tenant_id=$1)::text AS bookings,
          (SELECT count(*) FROM cookie_booking.command_receipts WHERE tenant_id=$1)::text AS receipts,
          (SELECT count(*) FROM cookie_jobs.outbox_events WHERE tenant_id=$1)::text AS events`,
        [tenant],
      );
      assert.deepEqual(final.rows[0], {
        bookings: "2",
        receipts: "2",
        events: "2",
      });
    } finally {
      // Synthetic-only cleanup after committed concurrency fixtures.
      const scopedTables = [
        "cookie_booking.command_receipts",
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
      for (const table of scopedTables) {
        await pool
          .query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant])
          .catch(() => undefined);
      }
      await pool
        .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1", [tenant])
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [[owner, outsider]],
        )
        .catch(() => undefined);
      await pool.end();
    }
  },
);
