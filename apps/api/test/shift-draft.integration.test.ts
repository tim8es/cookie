import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import {
  createShiftDraftInternal,
  editShiftDraftInternal,
  type InternalCreateShiftDraft,
} from "../../../packages/domain-scheduling/src/draft-shift.js";
import { publishShiftInternal } from "../../../packages/domain-scheduling/src/publish-shift.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "protected draft create/edit enforces ownership, revisions and atomic replay",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-shift-draft-synthetic-test",
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
    const branchA = randomUUID();
    const branchB = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-shift-draft",
    };
    const input: InternalCreateShiftDraft = {
      actor,
      staffId: staff,
      locationId: branchA,
      startAt: "2027-04-12T10:00:00Z",
      endAt: "2027-04-12T12:00:00Z",
      idempotencyKey: "create-draft-a",
    };
    const allow = async (): Promise<void> => undefined;
    const bookingAt = (idempotencyKey: string, startAt: string) =>
      createBookingInternal(
        pool,
        {
          actor,
          customerId: customer,
          staffId: staff,
          serviceId: service,
          locationId: branchA,
          startAt,
          idempotencyKey,
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
         VALUES ($1::uuid,$3::uuid,'Synthetic drafts A'),
                ($2::uuid,$3::uuid,'Synthetic drafts B')`,
        [tenant, otherTenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'A','UTC'),
                ($1::uuid,$3::uuid,'B','Europe/Helsinki')`,
        [tenant, branchA, branchB],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid)`,
        [tenant, owner, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
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
        [tenant, staff, branchA, branchB],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$5::uuid,true),
                ($1::uuid,$2::uuid,$4::uuid,$5::uuid,true)`,
        [tenant, staff, branchA, branchB, service],
      );

      await assert.rejects(
        createShiftDraftInternal(
          pool,
          { ...input, actor: { ...actor, identityId: outsider } },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        createShiftDraftInternal(
          pool,
          { ...input, actor: { ...actor, tenantId: otherTenant } },
          allow,
        ),
        { code: "DRAFT_TARGET_UNAVAILABLE" },
      );
      await assert.rejects(
        createShiftDraftInternal(
          pool,
          { ...input, startAt: "2027-04-12T12:00:00Z" },
          allow,
        ),
        { code: "INVALID_DRAFT_COMMAND" },
      );
      await assert.rejects(
        createShiftDraftInternal(
          pool,
          { ...input, startAt: "2026-01-01T10:00:00Z", endAt: "2026-01-01T12:00:00Z" },
          allow,
        ),
        { code: "DRAFT_TARGET_UNAVAILABLE" },
      );
      await assert.rejects(
        createShiftDraftInternal(pool, input, async () => {
          throw new Error("OWNER_REVIEW_REQUIRED");
        }),
        { code: "DRAFT_POLICY_DENIED" },
      );

      let createChecks = 0;
      const createAllow = async (): Promise<void> => {
        createChecks++;
      };
      const [first, firstReplay] = await Promise.all([
        createShiftDraftInternal(pool, input, createAllow),
        createShiftDraftInternal(pool, input, createAllow),
      ]);
      assert.deepEqual(first, firstReplay);
      assert.deepEqual(first, {
        shiftId: first.shiftId,
        staffId: staff,
        locationId: branchA,
        startAt: "2027-04-12T10:00:00.000Z",
        endAt: "2027-04-12T12:00:00.000Z",
        active: false,
        revision: 0,
      });
      assert.equal(createChecks, 1);
      await assert.rejects(
        createShiftDraftInternal(
          pool,
          { ...input, endAt: "2027-04-12T13:00:00Z" },
          createAllow,
        ),
        { code: "DRAFT_KEY_REUSED" },
      );
      await assert.rejects(
        bookingAt("unpublished-window", "2027-04-12T10:00:00Z"),
        { code: "BOOKING_NOT_AVAILABLE" },
      );

      const deniedEdit = {
        actor,
        shiftId: first.shiftId,
        expectedRevision: 0,
        startAt: "2027-04-12T10:30:00Z",
        endAt: "2027-04-12T12:30:00Z",
        idempotencyKey: "edit-draft-1",
      };
      await assert.rejects(
        editShiftDraftInternal(pool, deniedEdit, async () => {
          throw new Error("EDIT_REQUIRES_APPROVAL");
        }),
        { code: "DRAFT_POLICY_DENIED" },
      );
      await assert.rejects(
        editShiftDraftInternal(
          pool,
          { ...deniedEdit, actor: { ...actor, identityId: outsider } },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        editShiftDraftInternal(
          pool,
          { ...deniedEdit, expectedRevision: 1, idempotencyKey: "stale" },
          allow,
        ),
        { code: "DRAFT_STALE_REVISION" },
      );
      const stillOriginal = await pool.query<{
        start_at: Date;
        end_at: Date;
        draft_revision: number;
      }>(
        `SELECT start_at,end_at,draft_revision
           FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, first.shiftId],
      );
      assert.equal(stillOriginal.rows[0]?.start_at.toISOString(), first.startAt);
      assert.equal(stillOriginal.rows[0]?.end_at.toISOString(), first.endAt);
      assert.equal(stillOriginal.rows[0]?.draft_revision, 0);

      // Outbox key collision occurs *after* shift UPDATE and audit INSERT:
      // a failed transaction must rollback both and leave the key reusable.
      const poisonedDedupe = `schedule.shift.draft.edit:${first.shiftId}:1`;
      const poisonId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
          (id,tenant_id,dedupe_key,topic,payload,fingerprint,max_attempts)
         VALUES ($1::uuid,$2::uuid,$3,'schedule.shift.draft.edited',
                 '{"synthetic":true}'::jsonb,repeat('f',64),5)`,
        [poisonId, tenant, poisonedDedupe],
      );
      await assert.rejects(
        editShiftDraftInternal(pool, deniedEdit, allow),
        /Outbox idempotency key reused/,
      );
      const rolledBack = await pool.query<{
        draft_revision: number;
        events: string;
        receipts: string;
      }>(
        `SELECT draft_revision,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_audit
           WHERE tenant_id=$1::uuid AND shift_id=$2::uuid AND operation='edit') AS events,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_receipts
           WHERE tenant_id=$1::uuid AND shift_id=$2::uuid AND operation='edit') AS receipts
         FROM cookie_scheduling.shift_windows
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, first.shiftId],
      );
      assert.deepEqual(rolledBack.rows[0], {
        draft_revision: 0,
        events: "0",
        receipts: "0",
      });
      await pool.query(
        `DELETE FROM cookie_jobs.outbox_events
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, poisonId],
      );

      let editChecks = 0;
      const editAllow = async (): Promise<void> => {
        editChecks++;
      };
      const [edited, editReplay] = await Promise.all([
        editShiftDraftInternal(pool, deniedEdit, editAllow),
        editShiftDraftInternal(pool, deniedEdit, editAllow),
      ]);
      assert.deepEqual(edited, editReplay);
      assert.equal(editChecks, 1);
      assert.equal(edited.revision, 1);
      assert.equal(edited.startAt, "2027-04-12T10:30:00.000Z");
      await assert.rejects(
        editShiftDraftInternal(
          pool,
          { ...deniedEdit, endAt: "2027-04-12T13:00:00Z" },
          editAllow,
        ),
        { code: "DRAFT_KEY_REUSED" },
      );

      // Distinct concurrent edits of revision 1 must not silently overwrite.
      const contender = {
        ...deniedEdit,
        expectedRevision: 1,
        idempotencyKey: "edit-next-first",
        startAt: "2027-04-12T10:45:00Z",
      };
      const contender2 = {
        ...contender,
        idempotencyKey: "edit-next-second",
        startAt: "2027-04-12T11:00:00Z",
      };
      const race = await Promise.allSettled([
        editShiftDraftInternal(pool, contender, allow),
        editShiftDraftInternal(pool, contender2, allow),
      ]);
      assert.equal(race.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(race.filter((item) => item.status === "rejected").length, 1);
      const rejected = race.find((item) => item.status === "rejected");
      assert.equal(
        rejected?.status === "rejected"
          ? (rejected.reason as { code?: string }).code
          : null,
        "DRAFT_STALE_REVISION",
      );

      const final = await pool.query<{
        start_at: Date;
        end_at: Date;
        draft_revision: number;
        active: boolean;
      }>(
        `SELECT start_at,end_at,draft_revision,active
           FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, first.shiftId],
      );
      assert.equal(final.rows[0]?.draft_revision, 2);
      assert.equal(final.rows[0]?.active, false);
      assert.ok(
        [
          "2027-04-12T10:45:00.000Z",
          "2027-04-12T11:00:00.000Z",
        ].includes(final.rows[0]!.start_at.toISOString()),
      );

      // Publishing sees the final committed draft interval. After publish,
      // an edit with a different key cannot alter a Confirmed schedule.
      const published = await publishShiftInternal(
        pool,
        {
          actor,
          shiftId: first.shiftId,
          idempotencyKey: "publish-protected-draft",
        },
        allow,
      );
      assert.equal(published.active, true);
      assert.equal(published.startAt, final.rows[0]?.start_at.toISOString());
      await assert.rejects(
        editShiftDraftInternal(
          pool,
          {
            ...deniedEdit,
            expectedRevision: 2,
            idempotencyKey: "edit-after-publish",
          },
          allow,
        ),
        { code: "DRAFT_NOT_EDITABLE" },
      );
      const confirmed = await bookingAt(
        "booking-after-draft-publish",
        published.startAt.replace(".000Z", "Z"),
      );
      assert.equal(confirmed.status, "Confirmed");
      assert.deepEqual(
        await editShiftDraftInternal(pool, deniedEdit, editAllow),
        edited,
        "exact same-key replay keeps its original result, even after publish",
      );

      // Drafts in another branch may overlap while inactive. Their
      // publication is checked independently by protected PublishShift.
      const draftB = await createShiftDraftInternal(
        pool,
        {
          ...input,
          locationId: branchB,
          idempotencyKey: "branch-b-draft-overlap",
          startAt: "2027-04-12T11:00:00Z",
          endAt: "2027-04-12T12:00:00Z",
        },
        allow,
      );
      await assert.rejects(
        publishShiftInternal(
          pool,
          {
            actor,
            shiftId: draftB.shiftId,
            idempotencyKey: "publish-overlapping-b",
          },
          allow,
        ),
        { code: "SHIFT_CROSS_LOCATION_CONFLICT" },
      );

      // Pre-existing inactive rows have no draft audit; they cannot be
      // edited without verified origin, even if caller has schedule.manage.
      const legacy = randomUUID();
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
          (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,
           '2027-05-01T10:00:00Z','2027-05-01T12:00:00Z',false)`,
        [tenant, legacy, staff, branchA],
      );
      await assert.rejects(
        editShiftDraftInternal(
          pool,
          {
            ...deniedEdit,
            shiftId: legacy,
            startAt: "2027-05-01T10:30:00Z",
            endAt: "2027-05-01T12:30:00Z",
            idempotencyKey: "legacy-unaudited",
          },
          allow,
        ),
        { code: "DRAFT_NOT_EDITABLE" },
      );

      const successCounts = await pool.query<{
        draft_rows: string;
        audit_rows: string;
        receipt_rows: string;
        draft_events: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_scheduling.shift_windows
           WHERE tenant_id=$1::uuid) AS draft_rows,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_audit
           WHERE tenant_id=$1::uuid) AS audit_rows,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_receipts
           WHERE tenant_id=$1::uuid) AS receipt_rows,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
           WHERE tenant_id=$1::uuid AND topic LIKE 'schedule.shift.draft.%')
            AS draft_events`,
        [tenant],
      );
      assert.deepEqual(successCounts.rows[0], {
        draft_rows: "3",
        audit_rows: "4",
        receipt_rows: "4",
        draft_events: "4",
      });
    } finally {
      const tables = [
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
        .query("DELETE FROM cookie_tenancy.organizations WHERE id=ANY($1::uuid[])", [
          [tenant, otherTenant],
        ])
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
