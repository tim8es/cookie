import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import {
  disableShiftInternal,
  type InternalDisableShift,
} from "../../../packages/domain-scheduling/src/disable-shift.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "shift disable cannot orphan Confirmed appointments and serializes with booking creation",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-shift-disable-synthetic-test",
      max: 8,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const outsider = randomUUID();
    const role = randomUUID();
    const staff = randomUUID();
    const customer = randomUUID();
    const service = randomUUID();
    const locationA = randomUUID();
    const locationB = randomUUID();
    const firstShift = randomUUID();
    const replacementShift = randomUUID();
    const branchBShift = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "f1-shift-disable-synthetic",
    };
    const command: InternalDisableShift = {
      actor,
      shiftId: firstShift,
      idempotencyKey: "disable-original-a",
    };
    const policy = async (): Promise<void> => undefined;
    const book = (key: string, startAt: string, locationId = locationA) =>
      createBookingInternal(
        pool,
        {
          actor,
          customerId: customer,
          staffId: staff,
          serviceId: service,
          locationId,
          startAt,
          idempotencyKey: key,
        },
        async () => undefined,
      );

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid)",
        [owner, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES ($1::uuid,$2::uuid,'Synthetic shift coverage')`,
        [tenant, owner],
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
        `INSERT INTO cookie_customers.customers(tenant_id,id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenant, customer],
      );
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,
            post_service_buffer_minutes,base_price_kopecks,active)
         VALUES ($1::uuid,$2::uuid,'Shift test',60,10,10000,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
           (tenant_id,id,display_name,active,bookable)
         VALUES ($1::uuid,$2::uuid,'Staff',true,true)`,
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
         VALUES ($1::uuid,$2::uuid,$5::uuid,$6::uuid,
                 '2027-04-12T09:00:00Z','2027-04-12T18:00:00Z',true),
                ($1::uuid,$3::uuid,$5::uuid,$6::uuid,
                 '2027-04-12T09:00:00Z','2027-04-12T18:00:00Z',false),
                ($1::uuid,$4::uuid,$5::uuid,$7::uuid,
                 '2027-04-12T09:00:00Z','2027-04-12T18:00:00Z',true)`,
        [
          tenant,
          firstShift,
          replacementShift,
          branchBShift,
          staff,
          locationA,
          locationB,
        ],
      );

      const confirmed = await book("original-a", "2027-04-12T10:00:00Z");
      await assert.rejects(disableShiftInternal(pool, command, policy), {
        code: "SHIFT_BOOKING_CONFLICT",
      });
      await assert.rejects(
        disableShiftInternal(
          pool,
          { ...command, actor: { ...actor, identityId: outsider } },
          policy,
        ),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        disableShiftInternal(
          pool,
          { ...command, actor: { ...actor, tenantId: randomUUID() } },
          policy,
        ),
        { code: "SHIFT_NOT_FOUND" },
      );
      await assert.rejects(
        disableShiftInternal(pool, command, async () => {
          throw new Error("CHANGE_REQUIRES_REVIEW");
        }),
        { code: "SHIFT_POLICY_DENIED" },
      );
      const afterRejected = await pool.query<{ active: boolean }>(
        `SELECT active FROM cookie_scheduling.shift_windows
         WHERE tenant_id=$1 AND id=$2`,
        [tenant, firstShift],
      );
      assert.equal(afterRejected.rows[0]?.active, true);

      // An explicitly enabled alternate shift still covers the entire
      // Confirmed occupied interval, including the post-service buffer.
      await pool.query(
        `UPDATE cookie_scheduling.shift_windows SET active=true
         WHERE tenant_id=$1 AND id=$2`,
        [tenant, replacementShift],
      );
      let checks = 0;
      const assertSynthetic = async (): Promise<void> => {
        checks++;
      };
      const [disabled, replay] = await Promise.all([
        disableShiftInternal(pool, command, assertSynthetic),
        disableShiftInternal(pool, command, assertSynthetic),
      ]);
      assert.deepEqual(replay, disabled);
      assert.equal(disabled.shiftId, firstShift);
      assert.equal(disabled.active, false);
      assert.equal(checks, 1);
      await assert.rejects(
        disableShiftInternal(
          pool,
          { ...command, shiftId: branchBShift },
          assertSynthetic,
        ),
        { code: "SHIFT_KEY_REUSED" },
      );
      await assert.rejects(
        disableShiftInternal(
          pool,
          {
            ...command,
            shiftId: firstShift,
            idempotencyKey: "second-key-after-disabled",
          },
          assertSynthetic,
        ),
        { code: "SHIFT_NOT_ACTIVE" },
      );

      const activeConfirm = await pool.query<{
        status: string;
        shift_active: boolean;
      }>(
        `SELECT booking.status, shift.active AS shift_active
         FROM cookie_booking.bookings AS booking
         JOIN cookie_scheduling.shift_windows AS shift
           ON shift.tenant_id=booking.tenant_id
          AND shift.id=$3::uuid
         WHERE booking.tenant_id=$1::uuid AND booking.id=$2::uuid`,
        [tenant, confirmed.bookingId, replacementShift],
      );
      assert.deepEqual(activeConfirm.rows[0], {
        status: "Confirmed",
        shift_active: true,
      });
      await assert.rejects(
        disableShiftInternal(
          pool,
          {
            ...command,
            shiftId: replacementShift,
            idempotencyKey: "disable-replacement",
          },
          assertSynthetic,
        ),
        { code: "SHIFT_BOOKING_CONFLICT" },
      );

      // Two concurrent attempts to book in B and deactivate its sole shift
      // cannot both commit, regardless of the winner of the staff lock.
      const contested = await Promise.allSettled([
        disableShiftInternal(
          pool,
          {
            ...command,
            shiftId: branchBShift,
            idempotencyKey: "concurrent-disable-b",
          },
          assertSynthetic,
        ),
        book("concurrent-book-b", "2027-04-12T12:00:00Z", locationB),
      ]);
      assert.equal(
        contested.filter((item) => item.status === "fulfilled").length,
        1,
      );
      const branchB = await pool.query<{ active: boolean }>(
        `SELECT active FROM cookie_scheduling.shift_windows
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, branchBShift],
      );
      const activeB = branchB.rows[0]?.active;
      if (activeB === false) {
        await assert.rejects(
          book("new-book-b-after-disable", "2027-04-12T14:00:00Z", locationB),
          { code: "BOOKING_NOT_AVAILABLE" },
        );
      } else {
        assert.equal(
          contested[0]?.status,
          "rejected",
          "a Confirmed visit blocks disabling its only active shift",
        );
      }

      const receipts = await pool.query<{
        receipt_count: string;
        audit_count: string;
        event_count: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_scheduling.shift_disable_receipts
            WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS receipt_count,
          (SELECT count(*)::text FROM cookie_scheduling.shift_disable_audit
            WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS audit_count,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND
                  dedupe_key=$3) AS event_count`,
        [tenant, firstShift, `schedule.shift.disabled:${firstShift}`],
      );
      assert.deepEqual(receipts.rows[0], {
        receipt_count: "1",
        audit_count: "1",
        event_count: "1",
      });
    } finally {
      const tables = [
        "cookie_scheduling.shift_disable_receipts",
        "cookie_scheduling.shift_disable_audit",
        "cookie_booking.command_receipts",
        "cookie_jobs.outbox_events",
        "cookie_booking.time_change_audit",
        "cookie_booking.booking_state_audit",
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
      for (const table of tables) {
        await pool
          .query(`DELETE FROM ${table} WHERE tenant_id=$1::uuid`, [tenant])
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
