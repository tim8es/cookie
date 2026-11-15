import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { cancelBookingInternal } from "../../../packages/domain-booking/src/cancel.js";
import {
  createBookingInternal,
  type InternalCreateBooking,
} from "../../../packages/domain-booking/src/create.js";
import {
  rescheduleBookingInternal,
} from "../../../packages/domain-booking/src/reschedule.js";
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
         VALUES($1,$2,'owner','Synthetic owner',ARRAY['booking.create','booking.cancel','booking.reschedule'])`,
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

      // Business cancellation is an internal command with a REQUIRED trusted
      // policy callback. Never infer customer self-service permissions.
      const cancelCommand = {
        actor,
        bookingId: secondBooking.bookingId,
        idempotencyKey: "cancel-confirmed-once",
      };
      await assert.rejects(
        cancelBookingInternal(pool, cancelCommand, async () => {
          throw new Error("Synthetic cancellation cutoff denied");
        }),
        { code: "CANCELLATION_POLICY_DENIED" },
      );
      const stillConfirmed = await pool.query<{ status: string }>(
        "SELECT status FROM cookie_booking.bookings WHERE tenant_id=$1 AND id=$2",
        [tenant, secondBooking.bookingId],
      );
      assert.equal(stillConfirmed.rows[0]?.status, "Confirmed");

      await assert.rejects(
        cancelBookingInternal(
          pool,
          { ...cancelCommand, actor: { ...actor, identityId: outsider } },
          async () => undefined,
        ),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        cancelBookingInternal(
          pool,
          { ...cancelCommand, actor: { ...actor, tenantId: randomUUID() } },
          async () => undefined,
        ),
        { code: "BOOKING_NOT_FOUND" },
      );

      let cancellationPolicies = 0;
      const allowSyntheticCancellation = async (
        _client: unknown,
        booking: { readonly startAt: string },
      ): Promise<void> => {
        cancellationPolicies++;
        assert.equal(booking.startAt, "2027-04-12T14:00:00.000Z");
      };
      const [cancelled, retry] = await Promise.all([
        cancelBookingInternal(pool, cancelCommand, allowSyntheticCancellation),
        cancelBookingInternal(pool, cancelCommand, allowSyntheticCancellation),
      ]);
      assert.deepEqual(retry, cancelled);
      assert.equal(cancelled.status, "CancelledByBusiness");
      assert.equal(cancelled.bookingId, secondBooking.bookingId);
      assert.equal(cancellationPolicies, 1);
      assert.ok(Number.isFinite(new Date(cancelled.cancelledAt).getTime()));

      await assert.rejects(
        cancelBookingInternal(
          pool,
          {
            ...cancelCommand,
            bookingId: first.bookingId,
          },
          allowSyntheticCancellation,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );
      await assert.rejects(
        cancelBookingInternal(
          pool,
          {
            ...cancelCommand,
            idempotencyKey: "different-key-same-booking",
          },
          allowSyntheticCancellation,
        ),
        { code: "BOOKING_NOT_CONFIRMED" },
      );

      const auditAndEvent = await pool.query<{
        status: string;
        audit_count: string;
        cancelled_event_count: string;
        receipt_count: string;
      }>(
        `SELECT
          (SELECT status FROM cookie_booking.bookings WHERE tenant_id=$1 AND id=$2)
            AS status,
          (SELECT count(*)::text FROM cookie_booking.booking_state_audit
            WHERE tenant_id=$1 AND booking_id=$2) AS audit_count,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1 AND topic='booking.cancelled') AS cancelled_event_count,
          (SELECT count(*)::text FROM cookie_booking.command_receipts
            WHERE tenant_id=$1 AND operation='booking.cancel') AS receipt_count`,
        [tenant, secondBooking.bookingId],
      );
      assert.deepEqual(auditAndEvent.rows[0], {
        status: "CancelledByBusiness",
        audit_count: "1",
        cancelled_event_count: "1",
        receipt_count: "1",
      });

      // The staff slot is actually released by the exclusion constraint.
      const rebooked = await createBookingInternal(
        pool,
        {
          ...command,
          startAt: "2027-04-12T14:00:00Z",
          idempotencyKey: "new-create-after-cancel",
        },
        allowSyntheticEntitlement,
      );
      assert.notEqual(rebooked.bookingId, secondBooking.bookingId);
      assert.equal(rebooked.status, "Confirmed");
      assert.equal(rebooked.priceKopecks, secondBooking.priceKopecks);

      const afterCancellation = await pool.query<{
        confirmed: string;
        cancelled: string;
        receipts: string;
        events: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_booking.bookings
             WHERE tenant_id=$1 AND status='Confirmed') AS confirmed,
          (SELECT count(*)::text FROM cookie_booking.bookings
             WHERE tenant_id=$1 AND status='CancelledByBusiness') AS cancelled,
          (SELECT count(*)::text FROM cookie_booking.command_receipts
             WHERE tenant_id=$1) AS receipts,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
             WHERE tenant_id=$1) AS events`,
        [tenant],
      );
      assert.deepEqual(afterCancellation.rows[0], {
        confirmed: "2",
        cancelled: "1",
        receipts: "4",
        events: "4",
      });

      // The second Booking remains Cancelled; a time-only reschedule never
      // changes state, price, service, staff or branch.
      const moveCommand = {
        actor,
        bookingId: first.bookingId,
        idempotencyKey: "move-original-booking",
        newStartAt: "2027-04-12T16:00:00Z",
      };
      let movePolicies = 0;
      const allowSyntheticReschedule = async (
        _client: unknown,
        booking: { readonly oldStartAt: string },
      ): Promise<void> => {
        movePolicies++;
        assert.equal(booking.oldStartAt, first.startAt);
      };
      await assert.rejects(
        rescheduleBookingInternal(pool, moveCommand, async () => {
          throw new Error("Synthetic reschedule deadline denied");
        }),
        { code: "RESCHEDULE_POLICY_DENIED" },
      );
      await assert.rejects(
        rescheduleBookingInternal(
          pool,
          {
            ...moveCommand,
            idempotencyKey: "reschedule-in-break",
            newStartAt: "2027-04-12T12:05:00Z",
          },
          allowSyntheticReschedule,
        ),
        { code: "RESCHEDULE_NOT_AVAILABLE" },
      );
      await assert.rejects(
        rescheduleBookingInternal(
          pool,
          {
            ...moveCommand,
            idempotencyKey: "reschedule-overlap-other-booking",
            newStartAt: "2027-04-12T14:05:00Z",
          },
          allowSyntheticReschedule,
        ),
        { code: "RESCHEDULE_NOT_AVAILABLE" },
      );
      await assert.rejects(
        rescheduleBookingInternal(
          pool,
          { ...moveCommand, actor: { ...actor, identityId: outsider } },
          allowSyntheticReschedule,
        ),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        rescheduleBookingInternal(
          pool,
          {
            ...moveCommand,
            bookingId: secondBooking.bookingId,
            idempotencyKey: "reschedule-cancelled",
          },
          async () => undefined,
        ),
        { code: "BOOKING_NOT_CONFIRMED" },
      );

      const beforeMove = await pool.query<{
        status: string;
        start_at: Date;
        price_kopecks_snapshot: string;
      }>(
        `SELECT status, start_at, price_kopecks_snapshot::text
         FROM cookie_booking.bookings WHERE tenant_id=$1 AND id=$2`,
        [tenant, first.bookingId],
      );
      assert.equal(beforeMove.rows[0]?.status, "Confirmed");
      assert.equal(beforeMove.rows[0]?.start_at.toISOString(), first.startAt);
      assert.equal(beforeMove.rows[0]?.price_kopecks_snapshot, "150000");

      // Changing current Catalog price/duration never rewrites the original
      // Confirmed booking's duration, buffer, promotion or price snapshots.
      await pool.query(
        "UPDATE cookie_catalog.services SET duration_minutes=75 WHERE tenant_id=$1 AND id=$2",
        [tenant, service],
      );
      const [moved, sameKeyRetry] = await Promise.all([
        rescheduleBookingInternal(
          pool,
          moveCommand,
          allowSyntheticReschedule,
        ),
        rescheduleBookingInternal(
          pool,
          moveCommand,
          allowSyntheticReschedule,
        ),
      ]);
      assert.deepEqual(sameKeyRetry, moved);
      assert.deepEqual(moved, {
        bookingId: first.bookingId,
        status: "Confirmed",
        previousStartAt: "2027-04-12T10:00:00.000Z",
        startAt: "2027-04-12T16:00:00.000Z",
        endAt: "2027-04-12T17:00:00.000Z",
        occupiedUntil: "2027-04-12T17:10:00.000Z",
        priceKopecks: "150000",
      });
      assert.equal(
        movePolicies,
        3,
        "two rejected availability attempts and one successful reschedule",
      );
      await assert.rejects(
        rescheduleBookingInternal(
          pool,
          { ...moveCommand, newStartAt: "2027-04-12T09:00:00Z" },
          allowSyntheticReschedule,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );
      const finalMove = await pool.query<{
        staff_id: string;
        location_id: string;
        service_id: string;
        start_at: Date;
        end_at: Date;
        occupied_until: Date;
        price_kopecks_snapshot: string;
        service_duration_minutes_snapshot: number;
      }>(
        `SELECT staff_id::text, location_id::text, service_id::text,
          start_at, end_at, occupied_until,
          price_kopecks_snapshot::text, service_duration_minutes_snapshot
         FROM cookie_booking.bookings WHERE tenant_id=$1 AND id=$2`,
        [tenant, first.bookingId],
      );
      assert.equal(finalMove.rows[0]?.staff_id, staff);
      assert.equal(finalMove.rows[0]?.location_id, locationA);
      assert.equal(finalMove.rows[0]?.service_id, service);
      assert.equal(finalMove.rows[0]?.start_at.toISOString(), moved.startAt);
      assert.equal(finalMove.rows[0]?.end_at.toISOString(), moved.endAt);
      assert.equal(
        finalMove.rows[0]?.occupied_until.toISOString(),
        moved.occupiedUntil,
      );
      assert.equal(finalMove.rows[0]?.service_duration_minutes_snapshot, 60);
      assert.equal(finalMove.rows[0]?.price_kopecks_snapshot, "150000");

      const moveLedger = await pool.query<{
        receipts: string;
        outbox_events: string;
        audit_rows: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM cookie_booking.command_receipts
             WHERE tenant_id=$1 AND operation='booking.reschedule') AS receipts,
           (SELECT count(*)::text FROM cookie_jobs.outbox_events
             WHERE tenant_id=$1 AND topic='booking.rescheduled') AS outbox_events,
           (SELECT count(*)::text FROM cookie_booking.time_change_audit
             WHERE tenant_id=$1) AS audit_rows`,
        [tenant],
      );
      assert.deepEqual(moveLedger.rows[0], {
        receipts: "1",
        outbox_events: "1",
        audit_rows: "1",
      });
    } finally {
      // Synthetic-only cleanup after committed concurrency fixtures.
      const scopedTables = [
        "cookie_booking.command_receipts",
        "cookie_booking.booking_state_audit",
        "cookie_booking.time_change_audit",
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
