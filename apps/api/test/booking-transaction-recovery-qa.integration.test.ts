import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { cancelBookingInternal } from "../../../packages/domain-booking/src/cancel.js";
import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface DurableCounts {
  readonly bookings: string;
  readonly confirmed: string;
  readonly cancelled: string;
  readonly receipts: string;
  readonly createEvents: string;
  readonly cancelEvents: string;
  readonly cancelAudit: string;
  readonly authAudit: string;
}

async function countTenantState(
  pool: Pool,
  tenantId: string,
): Promise<DurableCounts> {
  const result = await pool.query<DurableCounts>(
    `SELECT
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid) AS bookings,
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed,
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND status='CancelledByBusiness') AS cancelled,
       (SELECT count(*)::text FROM cookie_booking.command_receipts
        WHERE tenant_id=$1::uuid) AS receipts,
       (SELECT count(*)::text FROM cookie_jobs.outbox_events
        WHERE tenant_id=$1::uuid AND topic='booking.confirmed') AS "createEvents",
       (SELECT count(*)::text FROM cookie_jobs.outbox_events
        WHERE tenant_id=$1::uuid AND topic='booking.cancelled') AS "cancelEvents",
       (SELECT count(*)::text FROM cookie_booking.booking_state_audit
        WHERE tenant_id=$1::uuid) AS "cancelAudit",
       (SELECT count(*)::text FROM cookie_identity.authorization_audit
        WHERE tenant_id=$1::uuid) AS "authAudit"`,
    [tenantId],
  );
  const row = result.rows[0];
  assert.ok(row, "tenant state query must return one aggregate row");
  return row;
}

type FaultTable = "cookie_jobs.outbox_events" | "cookie_booking.command_receipts";
type FaultOperation = "booking.confirmed" | "booking.cancelled" | "booking.create" | "booking.cancel";

/**
 * Test-only PostgreSQL failure injector. Its trigger returns an exception
 * exclusively for a generated synthetic tenant and target operation, even
 * though the trigger definition is temporarily attached to a shared table.
 *
 * The integration test runner is serial, and each injector is always dropped.
 * Never install this helper against a real database or expose it in runtime.
 */
async function installSyntheticWriteFault(
  pool: Pool,
  tenantId: string,
  table: FaultTable,
  operation: FaultOperation,
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 18);
  const functionName = `cookie_qa_fault_${suffix}`;
  const triggerName = `cookie_qa_trigger_${suffix}`;
  const column = table === "cookie_jobs.outbox_events" ? "topic" : "operation";
  const predicate = `NEW.tenant_id = '${tenantId}'::uuid AND NEW.${column} = '${operation}'`;
  await pool.query(
    `CREATE FUNCTION public.${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ${predicate} THEN
          RAISE EXCEPTION 'SYNTHETIC_QA_LATE_TRANSACTION_FAILURE'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END
      $$`,
  );
  try {
    await pool.query(
      `CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`,
    );
  } catch (error) {
    await pool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    throw error;
  }
  return async () => {
    try {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`);
    } finally {
      await pool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    }
  };
}

test(
  "late PostgreSQL Outbox/receipt faults roll back Create and CancelBooking, then same-key recovery succeeds",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-atomic-recovery",
      max: 3,
      connectionTimeoutMillis: 5_000,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const location = randomUUID();
    const staff = randomUUID();
    const customer = randomUUID();
    const service = randomUUID();
    const role = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-qa-transaction-failures",
    };
    const createCommand = {
      actor,
      customerId: customer,
      locationId: location,
      staffId: staff,
      serviceId: service,
      startAt: "2027-07-20T10:00:00Z",
      idempotencyKey: "same-create-after-rollback",
    };
    const allowEntitlement = async (): Promise<void> => undefined;
    const allowCancel = async (): Promise<void> => undefined;
    let activeFault: (() => Promise<void>) | undefined;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1::uuid,$2::uuid,'Synthetic transaction recovery')`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES($1::uuid,$2::uuid,'QA Location','UTC')`,
        [tenant, location],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES($1::uuid,$2::uuid)`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES($1::uuid,$2::uuid,'owner','Synthetic owner',
                ARRAY['booking.create','booking.cancel'])`,
        [tenant, role],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
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
         VALUES($1::uuid,$2::uuid,'QA service',60,10,125000,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
           (tenant_id,id,display_name,active,bookable)
         VALUES($1::uuid,$2::uuid,'QA staff',true,true)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES($1::uuid,$2::uuid,$3::uuid,true)`,
        [tenant, staff, location],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,true)`,
        [tenant, staff, location, service],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,
                '2027-07-20T09:00:00Z','2027-07-20T18:00:00Z',true)`,
        [tenant, randomUUID(), staff, location],
      );

      const empty: DurableCounts = {
        bookings: "0",
        confirmed: "0",
        cancelled: "0",
        receipts: "0",
        createEvents: "0",
        cancelEvents: "0",
        cancelAudit: "0",
        authAudit: "0",
      };
      assert.deepEqual(await countTenantState(pool, tenant), empty);

      // Failure AFTER the Booking INSERT, at Outbox INSERT.
      activeFault = await installSyntheticWriteFault(
        pool, tenant, "cookie_jobs.outbox_events", "booking.confirmed",
      );
      try {
        await assert.rejects(
          createBookingInternal(pool, createCommand, allowEntitlement),
          { code: "P0001" },
        );
      } finally {
        await activeFault();
        activeFault = undefined;
      }
      assert.deepEqual(
        await countTenantState(pool, tenant),
        empty,
        "failed Outbox insertion must roll back booking, receipt and preflight audit",
      );

      // Failure AFTER Booking + Outbox INSERT, at receipt INSERT.
      activeFault = await installSyntheticWriteFault(
        pool, tenant, "cookie_booking.command_receipts", "booking.create",
      );
      try {
        await assert.rejects(
          createBookingInternal(pool, createCommand, allowEntitlement),
          { code: "P0001" },
        );
      } finally {
        await activeFault();
        activeFault = undefined;
      }
      assert.deepEqual(
        await countTenantState(pool, tenant),
        empty,
        "failed receipt insertion must roll back even the already-inserted Outbox event",
      );

      // The ORIGINAL idempotency key must still be usable after a rollback.
      const created = await createBookingInternal(
        pool, createCommand, allowEntitlement,
      );
      assert.equal(created.status, "Confirmed");
      assert.equal(created.priceKopecks, "125000");
      assert.deepEqual(
        await createBookingInternal(pool, createCommand, async () => {
          throw new Error("entitlement must not be rechecked on committed replay");
        }),
        created,
      );
      const afterCreate = await countTenantState(pool, tenant);
      assert.deepEqual(afterCreate, {
        bookings: "1",
        confirmed: "1",
        cancelled: "0",
        receipts: "1",
        createEvents: "1",
        cancelEvents: "0",
        cancelAudit: "0",
        authAudit: "2",
      });

      const cancelCommand = {
        actor,
        bookingId: created.bookingId,
        idempotencyKey: "same-cancel-after-rollback",
      };

      // Failure AFTER status mutation + cancellation audit, at Outbox INSERT.
      activeFault = await installSyntheticWriteFault(
        pool, tenant, "cookie_jobs.outbox_events", "booking.cancelled",
      );
      try {
        await assert.rejects(
          cancelBookingInternal(pool, cancelCommand, allowCancel),
          { code: "P0001" },
        );
      } finally {
        await activeFault();
        activeFault = undefined;
      }
      assert.deepEqual(
        await countTenantState(pool, tenant),
        afterCreate,
        "cancel Outbox fault must not leave a cancelled booking or orphan audit",
      );

      // Failure AFTER status mutation + audit + Outbox, at receipt INSERT.
      activeFault = await installSyntheticWriteFault(
        pool, tenant, "cookie_booking.command_receipts", "booking.cancel",
      );
      try {
        await assert.rejects(
          cancelBookingInternal(pool, cancelCommand, allowCancel),
          { code: "P0001" },
        );
      } finally {
        await activeFault();
        activeFault = undefined;
      }
      assert.deepEqual(
        await countTenantState(pool, tenant),
        afterCreate,
        "cancel receipt fault must roll back status, audit and event atomically",
      );

      const cancelled = await cancelBookingInternal(
        pool, cancelCommand, allowCancel,
      );
      assert.equal(cancelled.status, "CancelledByBusiness");
      assert.deepEqual(
        await cancelBookingInternal(pool, cancelCommand, async () => {
          throw new Error("cancel policy must not run on committed same-key retry");
        }),
        cancelled,
      );
      assert.deepEqual(await countTenantState(pool, tenant), {
        bookings: "1",
        confirmed: "0",
        cancelled: "1",
        receipts: "2",
        createEvents: "1",
        cancelEvents: "1",
        cancelAudit: "1",
        authAudit: "4",
      });

      const linked = await pool.query<{ id: string; topic: string }>(
        `SELECT payload->>'bookingId' AS id, topic
         FROM cookie_jobs.outbox_events
         WHERE tenant_id=$1::uuid ORDER BY topic`,
        [tenant],
      );
      assert.deepEqual(linked.rows, [
        { id: created.bookingId, topic: "booking.cancelled" },
        { id: created.bookingId, topic: "booking.confirmed" },
      ]);
    } finally {
      if (activeFault) await activeFault().catch(() => undefined);
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
          await pool.query(
            `DELETE FROM ${table} WHERE tenant_id=$1::uuid`, [tenant],
          ).catch(() => undefined);
        }
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [tenant],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [owner],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
