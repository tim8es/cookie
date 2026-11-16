import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { createShiftDraftInternal } from "../../../packages/domain-scheduling/src/draft-shift.js";
import { editPublishedShiftInternal } from "../../../packages/domain-scheduling/src/edit-published-shift.js";
import { publishShiftInternal } from "../../../packages/domain-scheduling/src/publish-shift.js";
import { setScheduleEditPolicyInternal } from "../../../packages/domain-scheduling/src/approval.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface WaitRow {
  readonly pid: number;
  readonly blockers: number[];
  readonly waiting: boolean;
}

async function waitForBlocker(
  monitor: Pool,
  applicationName: string,
  blockerPid: number,
): Promise<number> {
  for (let i = 0; i < 150; i++) {
    const status = await monitor.query<WaitRow>(
      `SELECT pid, pg_blocking_pids(pid) AS blockers,
              wait_event_type='Lock' AS waiting
         FROM pg_stat_activity
        WHERE application_name=$1 AND state='active'
        ORDER BY backend_start LIMIT 1`,
      [applicationName],
    );
    const row = status.rows[0];
    if (row?.waiting && row.blockers.includes(blockerPid)) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "Expected PostgreSQL lock wait not reached for " + applicationName,
  );
}

test(
  "booking, published-shift edit and owner policy change cannot form a PostgreSQL deadlock",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const config = { connectionString: process.env.TEST_DATABASE_URL };
    const setup = new Pool({
      ...config,
      max: 3,
      application_name: "qa-cycle-setup",
    });
    const schedulePool = new Pool({
      ...config,
      max: 2,
      application_name: "qa-cycle-schedule",
    });
    const bookingPool = new Pool({
      ...config,
      max: 2,
      application_name: "qa-cycle-booking",
    });
    const ownerPool = new Pool({
      ...config,
      max: 2,
      application_name: "qa-cycle-owner",
    });
    const tenant = randomUUID();
    const identity = randomUUID();
    const role = randomUUID();
    const location = randomUUID();
    const staff = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: identity,
      correlationId: "synthetic-qa-three-way-lock-cycle",
    };
    const allow = async (): Promise<void> => undefined;
    let scheduleClient: PoolClient | undefined;
    let transactionOpen = false;
    let releaseStaff!: () => void;
    let staffAcquired!: () => void;
    const staffHeld = new Promise<void>((resolve) => {
      staffAcquired = resolve;
    });
    const resumeSchedule = new Promise<void>((resolve) => {
      releaseStaff = resolve;
    });
    let scheduleStarted = false;

    try {
      await runMigrations(setup, resolve(process.cwd(), "db/migrations"));
      await setup.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1)",
        [identity],
      );
      await setup.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES ($1,$2,'Synthetic three-way lock QA')`,
        [tenant, identity],
      );
      await setup.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1,$2,'QA location','UTC')`,
        [tenant, location],
      );
      await setup.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1,$2)`,
        [tenant, identity],
      );
      await setup.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES ($1,$2,'owner','Synthetic owner',
                 ARRAY['booking.create','schedule.manage'])`,
        [tenant, role],
      );
      await setup.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES ($1,$2,$3,$4)`,
        [tenant, randomUUID(), identity, role],
      );
      await setup.query(
        `INSERT INTO cookie_customers.customers(tenant_id,id)
         VALUES ($1,$2)`,
        [tenant, customer],
      );
      await setup.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,
            post_service_buffer_minutes,base_price_kopecks,active)
         VALUES ($1,$2,'Synthetic service',60,10,75000,true)`,
        [tenant, service],
      );
      await setup.query(
        `INSERT INTO cookie_staff.staff_profiles
           (tenant_id,id,display_name,active,bookable)
         VALUES ($1,$2,'Synthetic staff',true,true)`,
        [tenant, staff],
      );
      await setup.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES ($1,$2,$3,true)`,
        [tenant, staff, location],
      );
      await setup.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1,$2,$3,$4,true)`,
        [tenant, staff, location, service],
      );
      const draft = await createShiftDraftInternal(
        setup,
        {
          actor,
          staffId: staff,
          locationId: location,
          startAt: "2028-12-18T09:00:00Z",
          endAt: "2028-12-18T19:00:00Z",
          idempotencyKey: "qa-cycle-initial-shift",
        },
        allow,
      );
      await publishShiftInternal(
        setup,
        {
          actor,
          shiftId: draft.shiftId,
          idempotencyKey: "qa-cycle-published-shift",
        },
        allow,
      );

      scheduleClient = await schedulePool.connect();
      await scheduleClient.query("BEGIN");
      transactionOpen = true;
      await scheduleClient.query("SET LOCAL statement_timeout='7000ms'");
      const schedulePid = (
        await scheduleClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        )
      ).rows[0]!.pid;

      // Intercept the real scheduling handler immediately AFTER the
      // StaffProfile FOR UPDATE query. All later code still runs unchanged
      // on the actual physical PostgreSQL transaction.
      const physical = scheduleClient;
      const pausedClient = {
        async query(statement: string, values?: unknown[]): Promise<unknown> {
          const result = await physical.query(statement, values);
          if (
            !scheduleStarted &&
            statement.includes("FROM cookie_staff.staff_profiles") &&
            statement.includes("FOR UPDATE")
          ) {
            scheduleStarted = true;
            staffAcquired();
            await resumeSchedule;
          }
          return result;
        },
      } as unknown as PoolClient;

      const scheduleResult = editPublishedShiftInternal(
        schedulePool,
        {
          actor,
          shiftId: draft.shiftId,
          startAt: "2028-12-18T09:30:00Z",
          endAt: "2028-12-18T19:00:00Z",
          expectedPublishedRevision: 0,
          idempotencyKey: "qa-cycle-shift-edit",
        },
        allow,
        pausedClient,
      ).then(
        async (value) => {
          await physical.query("COMMIT");
          transactionOpen = false;
          return value;
        },
        async (error: unknown) => {
          await physical.query("ROLLBACK").catch(() => undefined);
          transactionOpen = false;
          throw error;
        },
      );
      // Do not leave the promise unobserved while arranging the other waits.
      const scheduleSettled = scheduleResult.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      await staffHeld;

      const bookingSettled = createBookingInternal(
        bookingPool,
        {
          actor,
          customerId: customer,
          staffId: staff,
          locationId: location,
          serviceId: service,
          startAt: "2028-12-18T14:00:00Z",
          idempotencyKey: "qa-cycle-booking",
        },
        allow,
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const bookingPid = await waitForBlocker(
        setup,
        "qa-cycle-booking",
        schedulePid,
      );

      // This real owner command takes Organization FOR UPDATE, conflicting
      // with the Booking's earlier Organization FOR SHARE policy lock.
      const ownerSettled = setScheduleEditPolicyInternal(ownerPool, {
        actor,
        mode: "direct",
        expectedRevision: 0,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForBlocker(setup, "qa-cycle-owner", bookingPid);
      releaseStaff();

      const [schedule, booking, owner] = await Promise.all([
        scheduleSettled,
        bookingSettled,
        ownerSettled,
      ]);
      const results = { schedule, booking, owner };
      const deadlockVictims = Object.entries(results)
        .filter(([, outcome]) => {
          if (outcome.ok) return false;
          const error = outcome.error as { code?: string };
          return error.code === "40P01";
        })
        .map(([name]) => name);
      assert.deepEqual(
        deadlockVictims,
        [],
        "PostgreSQL detected a policy/staff/owner lock-order cycle: " +
          deadlockVictims.join(", "),
      );
      for (const [name, result] of Object.entries(results)) {
        assert.equal(
          result.ok,
          true,
          name + " failed even without a 40P01 deadlock",
        );
      }

      const state = await setup.query<{
        bookingCount: string;
        revision: number;
      }>(
        `SELECT
           (SELECT count(*)::text FROM cookie_booking.bookings
             WHERE tenant_id=$1 AND status='Confirmed') AS "bookingCount",
           (SELECT published_revision FROM cookie_scheduling.shift_windows
             WHERE tenant_id=$1 AND id=$2) AS revision`,
        [tenant, draft.shiftId],
      );
      assert.deepEqual(state.rows[0], { bookingCount: "1", revision: 1 });
    } finally {
      releaseStaff();
      if (transactionOpen && scheduleClient)
        await scheduleClient.query("ROLLBACK").catch(() => undefined);
      scheduleClient?.release();
      for (const table of [
        "cookie_scheduling.shift_edit_receipts",
        "cookie_scheduling.shift_edit_audit",
        "cookie_scheduling.shift_publish_receipts",
        "cookie_scheduling.shift_publish_audit",
        "cookie_scheduling.shift_draft_receipts",
        "cookie_scheduling.shift_draft_audit",
        "cookie_scheduling.schedule_edit_policy_audit",
        "cookie_scheduling.schedule_edit_policies",
        "cookie_booking.command_receipts",
        "cookie_booking.booking_state_audit",
        "cookie_booking.time_change_audit",
        "cookie_jobs.outbox_events",
        "cookie_booking.bookings",
        "cookie_identity.authorization_audit",
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
      ]) {
        await setup
          .query("DELETE FROM " + table + " WHERE tenant_id=$1::uuid", [tenant])
          .catch(() => undefined);
      }
      await setup
        .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [
          tenant,
        ])
        .catch(() => undefined);
      await setup
        .query("DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [
          identity,
        ])
        .catch(() => undefined);
      await Promise.all([
        setup.end(),
        schedulePool.end(),
        bookingPool.end(),
        ownerPool.end(),
      ]);
    }
  },
);
