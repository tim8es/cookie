import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { createShiftDraftInternal } from "../../../packages/domain-scheduling/src/draft-shift.js";
import {
  editPublishedShiftInternal,
  type InternalEditPublishedShift,
} from "../../../packages/domain-scheduling/src/edit-published-shift.js";
import { publishShiftInternal } from "../../../packages/domain-scheduling/src/publish-shift.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "published shift edits preserve Confirmed bookings and serialize with bookings",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-published-edit-synthetic-test",
      max: 8,
    });
    const tenant = randomUUID();
    const otherTenant = randomUUID();
    const owner = randomUUID();
    const outsider = randomUUID();
    const role = randomUUID();
    const staff = randomUUID();
    const customer = randomUUID();
    const service = randomUUID();
    const locationA = randomUUID();
    const locationB = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-published-shift-edit",
    };
    const allow = async (): Promise<void> => undefined;
    const book = (idempotencyKey: string, startAt: string) =>
      createBookingInternal(
        pool,
        {
          actor,
          customerId: customer,
          staffId: staff,
          serviceId: service,
          locationId: locationA,
          startAt,
          idempotencyKey,
        },
        async () => undefined,
      );

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid),($2::uuid)",
        [owner, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'Synthetic edited shift A'),
                ($2::uuid,$3::uuid,'Synthetic edited shift B')`,
        [tenant, otherTenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'A','UTC'),
                ($1::uuid,$3::uuid,'B','Europe/Helsinki')`,
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
         VALUES ($1::uuid,$2::uuid,'Synthetic visit',60,10,10000,true)`,
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

      // This existing active B shift is deliberately a synthetic fixture;
      // its interval is 15:00–17:00 UTC, later than the initial A shift.
      const otherBranchShift = randomUUID();
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,
                 '2027-04-12T15:00:00Z','2027-04-12T17:00:00Z',true)`,
        [tenant, otherBranchShift, staff, locationB],
      );

      const draft = await createShiftDraftInternal(
        pool,
        {
          actor,
          staffId: staff,
          locationId: locationA,
          startAt: "2027-04-12T10:00:00Z",
          endAt: "2027-04-12T14:00:00Z",
          idempotencyKey: "initial-a-draft",
        },
        allow,
      );
      const published = await publishShiftInternal(
        pool,
        { actor, shiftId: draft.shiftId, idempotencyKey: "publish-a-draft" },
        allow,
      );
      assert.equal(published.active, true);

      const confirmed = await book("protected-booking", "2027-04-12T11:00:00Z");
      assert.equal(confirmed.status, "Confirmed");
      const command: InternalEditPublishedShift = {
        actor,
        shiftId: draft.shiftId,
        expectedPublishedRevision: 0,
        startAt: "2027-04-12T10:30:00Z",
        endAt: "2027-04-12T14:00:00Z",
        idempotencyKey: "move-a-start-safely",
      };

      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, actor: { ...actor, identityId: outsider } },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, actor: { ...actor, tenantId: otherTenant } },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_NOT_FOUND" },
      );
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, startAt: "2027-04-12T14:00:00Z" },
          allow,
        ),
        { code: "INVALID_PUBLISHED_SHIFT_EDIT" },
      );
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, endAt: "2027-04-12T12:00:00Z" },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_BOOKING_CONFLICT" },
        "post-service buffer through 12:10 must remain covered",
      );
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, startAt: "2027-04-12T11:10:00Z" },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_BOOKING_CONFLICT" },
      );
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, endAt: "2027-04-12T15:30:00Z" },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_CROSS_LOCATION_CONFLICT" },
      );
      await assert.rejects(
        editPublishedShiftInternal(pool, command, async () => {
          throw new Error("REQUIRES_APPROVAL");
        }),
        { code: "PUBLISHED_SHIFT_POLICY_DENIED" },
      );
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, startAt: "2027-04-12T10:00:00Z" },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_UNCHANGED" },
      );

      const afterDenied = await pool.query<{
        start_at: Date;
        end_at: Date;
        published_revision: number;
      }>(
        `SELECT start_at,end_at,published_revision
           FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, draft.shiftId],
      );
      assert.equal(afterDenied.rows[0]?.published_revision, 0);
      assert.equal(
        afterDenied.rows[0]?.start_at.toISOString(),
        "2027-04-12T10:00:00.000Z",
      );

      let policyCalls = 0;
      const countPolicy = async (): Promise<void> => {
        policyCalls++;
      };
      const [edited, replay] = await Promise.all([
        editPublishedShiftInternal(pool, command, countPolicy),
        editPublishedShiftInternal(pool, command, countPolicy),
      ]);
      assert.deepEqual(replay, edited);
      assert.equal(policyCalls, 1);
      assert.equal(edited.publishedRevision, 1);
      assert.equal(edited.previousStartAt, "2027-04-12T10:00:00.000Z");
      assert.equal(edited.startAt, "2027-04-12T10:30:00.000Z");
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, endAt: "2027-04-12T14:30:00Z" },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_KEY_REUSED" },
      );
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          { ...command, idempotencyKey: "stale-at-zero" },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_STALE_REVISION" },
      );

      // Inject an outbox collision after UPDATE + audit INSERT.
      // Retry with the original key must succeed after synthetic cleanup.
      const poisonedKey = `schedule.shift.edited:${draft.shiftId}:2`;
      const poisonedId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
           (id,tenant_id,dedupe_key,topic,payload,fingerprint,max_attempts)
         VALUES ($1::uuid,$2::uuid,$3,'schedule.shift.edited',
                 '{"synthetic":true}'::jsonb,repeat('f',64),5)`,
        [poisonedId, tenant, poisonedKey],
      );
      const next: InternalEditPublishedShift = {
        ...command,
        expectedPublishedRevision: 1,
        startAt: "2027-04-12T10:45:00Z",
        idempotencyKey: "late-failure-retry",
      };
      await assert.rejects(
        editPublishedShiftInternal(pool, next, allow),
        /Outbox idempotency key reused/,
      );
      const rollback = await pool.query<{
        published_revision: number;
        audits: string;
        receipts: string;
      }>(
        `SELECT shift.published_revision,
            (SELECT count(*)::text FROM cookie_scheduling.shift_edit_audit
               WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS audits,
            (SELECT count(*)::text FROM cookie_scheduling.shift_edit_receipts
               WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS receipts
           FROM cookie_scheduling.shift_windows AS shift
          WHERE shift.tenant_id=$1::uuid AND shift.id=$2::uuid`,
        [tenant, draft.shiftId],
      );
      assert.deepEqual(rollback.rows[0], {
        published_revision: 1,
        audits: "1",
        receipts: "1",
      });
      await pool.query(
        `DELETE FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, poisonedId],
      );
      const recovered = await editPublishedShiftInternal(pool, next, allow);
      assert.equal(recovered.publishedRevision, 2);

      // Same-location alternative shift fully covers the booked interval.
      // This makes a shrink of the originally publishing shift safe.
      const alternative = randomUUID();
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,
                '2027-04-12T09:00:00Z','2027-04-12T14:00:00Z',true)`,
        [tenant, alternative, staff, locationA],
      );
      const alternativeEdit = await editPublishedShiftInternal(
        pool,
        {
          ...command,
          expectedPublishedRevision: 2,
          startAt: "2027-04-12T12:30:00Z",
          idempotencyKey: "covered-by-alternative",
        },
        allow,
      );
      assert.equal(alternativeEdit.publishedRevision, 3);
      assert.equal(alternativeEdit.startAt, "2027-04-12T12:30:00.000Z");

      // Two distinct keys modifying one revision: exactly one succeeds.
      const baseRace: InternalEditPublishedShift = {
        ...command,
        expectedPublishedRevision: 3,
        startAt: "2027-04-12T12:35:00Z",
        idempotencyKey: "race-edit-first",
      };
      const race = await Promise.allSettled([
        editPublishedShiftInternal(pool, baseRace, allow),
        editPublishedShiftInternal(
          pool,
          {
            ...baseRace,
            startAt: "2027-04-12T12:40:00Z",
            idempotencyKey: "race-edit-second",
          },
          allow,
        ),
      ]);
      assert.equal(race.filter((item) => item.status === "fulfilled").length, 1);
      const rejected = race.find((item) => item.status === "rejected");
      assert.equal(
        rejected?.status === "rejected"
          ? (rejected.reason as { code?: string }).code
          : null,
        "PUBLISHED_SHIFT_STALE_REVISION",
      );
      const latest = await pool.query<{
        published_revision: number;
      }>(
        `SELECT published_revision FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, draft.shiftId],
      );
      assert.equal(latest.rows[0]?.published_revision, 4);
      assert.deepEqual(
        await editPublishedShiftInternal(pool, command, allow),
        edited,
        "same-key replay returns the original success after later revisions",
      );

      // Booking vs active-shift edit at the only shift for a later slot.
      // Regardless of which gets the shared staff lock, both cannot commit.
      const lateDraft = await createShiftDraftInternal(
        pool,
        {
          actor,
          staffId: staff,
          locationId: locationA,
          startAt: "2027-04-12T18:00:00Z",
          endAt: "2027-04-12T20:00:00Z",
          idempotencyKey: "late-shift-draft",
        },
        allow,
      );
      await publishShiftInternal(
        pool,
        {
          actor,
          shiftId: lateDraft.shiftId,
          idempotencyKey: "late-shift-publish",
        },
        allow,
      );
      const contest = await Promise.allSettled([
        editPublishedShiftInternal(
          pool,
          {
            actor,
            shiftId: lateDraft.shiftId,
            expectedPublishedRevision: 0,
            startAt: "2027-04-12T19:00:00Z",
            endAt: "2027-04-12T20:00:00Z",
            idempotencyKey: "late-shift-move",
          },
          allow,
        ),
        book("late-booking-race", "2027-04-12T18:00:00Z"),
      ]);
      assert.equal(
        contest.filter((item) => item.status === "fulfilled").length,
        1,
      );

      // An active legacy SQL row lacks a trusted publication audit and
      // can never be edited through this F1 command.
      await assert.rejects(
        editPublishedShiftInternal(
          pool,
          {
            ...command,
            shiftId: otherBranchShift,
            startAt: "2027-04-12T15:10:00Z",
            endAt: "2027-04-12T17:00:00Z",
            idempotencyKey: "legacy-forbidden",
          },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_NOT_EDITABLE" },
      );

      const integrity = await pool.query<{
        status: string;
        audits: string;
        receipts: string;
        events: string;
      }>(
        `SELECT
           (SELECT status FROM cookie_booking.bookings
              WHERE tenant_id=$1::uuid AND id=$2::uuid) AS status,
           (SELECT count(*)::text FROM cookie_scheduling.shift_edit_audit
              WHERE tenant_id=$1::uuid AND shift_id=$3::uuid) AS audits,
           (SELECT count(*)::text FROM cookie_scheduling.shift_edit_receipts
              WHERE tenant_id=$1::uuid AND shift_id=$3::uuid) AS receipts,
           (SELECT count(*)::text FROM cookie_jobs.outbox_events
              WHERE tenant_id=$1::uuid AND topic='schedule.shift.edited'
                AND payload->>'shiftId'=$3::text) AS events`,
        [tenant, confirmed.bookingId, draft.shiftId],
      );
      assert.deepEqual(integrity.rows[0], {
        status: "Confirmed",
        audits: "4",
        receipts: "4",
        events: "4",
      });
    } finally {
      const tables = [
        "cookie_scheduling.shift_edit_receipts",
        "cookie_scheduling.shift_edit_audit",
        "cookie_scheduling.shift_draft_receipts",
        "cookie_scheduling.shift_draft_audit",
        "cookie_scheduling.shift_publish_receipts",
        "cookie_scheduling.shift_publish_audit",
        "cookie_scheduling.shift_disable_receipts",
        "cookie_scheduling.shift_disable_audit",
        "cookie_booking.command_receipts",
        "cookie_booking.time_change_audit",
        "cookie_booking.booking_state_audit",
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
      for (const table of tables) {
        await pool
          .query(`DELETE FROM ${table} WHERE tenant_id=$1::uuid`, [tenant])
          .catch(() => undefined);
      }
      await pool
        .query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=ANY($1::uuid[])",
          [[tenant, otherTenant]],
        )
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
