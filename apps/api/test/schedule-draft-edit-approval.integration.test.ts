import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  editShiftDraftDirectInternal,
  requestShiftDraftEditInternal,
  reviewShiftDraftEditInternal,
} from "../../../packages/domain-scheduling/src/approval-draft-edit.js";
import { setScheduleEditPolicyInternal } from "../../../packages/domain-scheduling/src/approval.js";
import {
  createShiftDraftInternal,
  editShiftDraftInternal,
} from "../../../packages/domain-scheduling/src/draft-shift.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "approval-mode edit of future draft is atomic, versioned and revocation-safe",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-draft-edit-approval-synthetic-test",
      max: 8,
    });
    const tenant = randomUUID();
    const foreignTenant = randomUUID();
    const owner = randomUUID();
    const manager = randomUUID();
    const outsider = randomUUID();
    const ownerRole = randomUUID();
    const managerRole = randomUUID();
    const staff = randomUUID();
    const location = randomUUID();
    const ownerActor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-draft-edit-owner",
    };
    const managerActor = {
      tenantId: tenant,
      identityId: manager,
      correlationId: "synthetic-draft-edit-manager",
    };
    const allow = async (): Promise<void> => undefined;
    let index = 0;
    const makeDraft = async (day: number): Promise<string> => {
      const key = ++index;
      const draft = await createShiftDraftInternal(
        pool,
        {
          actor: ownerActor,
          staffId: staff,
          locationId: location,
          startAt: `2027-07-${String(day).padStart(2, "0")}T10:00:00Z`,
          endAt: `2027-07-${String(day).padStart(2, "0")}T13:00:00Z`,
          idempotencyKey: `synthetic-edit-draft-${key}`,
        },
        allow,
      );
      return draft.shiftId;
    };

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        `INSERT INTO cookie_identity.identities(id)
         VALUES ($1::uuid),($2::uuid),($3::uuid)`,
        [owner, manager, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'Synthetic draft edit approvals'),
                ($2::uuid,$3::uuid,'Synthetic foreign organization')`,
        [tenant, foreignTenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'Synthetic branch','UTC')`,
        [tenant, location],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid),($1::uuid,$4::uuid)`,
        [tenant, owner, manager, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions)
         VALUES ($1::uuid,$2::uuid,'owner','Synthetic owner',
                 ARRAY['schedule.manage']),
                ($1::uuid,$3::uuid,'admin','Synthetic manager',
                 ARRAY['schedule.manage'])`,
        [tenant, ownerRole, managerRole],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id,location_id)
         VALUES ($1::uuid,$2::uuid,$4::uuid,$6::uuid,NULL),
                ($1::uuid,$3::uuid,$5::uuid,$7::uuid,$8::uuid)`,
        [
          tenant,
          randomUUID(),
          randomUUID(),
          owner,
          manager,
          ownerRole,
          managerRole,
          location,
        ],
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
         VALUES ($1::uuid,$2::uuid,$3::uuid,true)`,
        [tenant, staff, location],
      );

      const shift = await makeDraft(12);
      const baseEdit = {
        actor: managerActor,
        shiftId: shift,
        expectedRevision: 0,
        startAt: "2027-07-12T10:30:00Z",
        endAt: "2027-07-12T13:30:00Z",
        idempotencyKey: "draft-edit-approval",
      };
      await assert.rejects(
        editShiftDraftDirectInternal(pool, baseEdit, allow),
        { code: "DRAFT_POLICY_DENIED" },
        "approval@0 denies direct time changes",
      );
      await assert.rejects(
        requestShiftDraftEditInternal(pool, {
          ...baseEdit,
          actor: { ...managerActor, tenantId: foreignTenant },
        }),
        { code: "DRAFT_EDIT_APPROVAL_NOT_FOUND" },
      );
      await assert.rejects(
        requestShiftDraftEditInternal(pool, {
          ...baseEdit,
          actor: { ...managerActor, identityId: outsider },
        }),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        requestShiftDraftEditInternal(pool, {
          ...baseEdit,
          startAt: "2027-07-12T10:12:15Z",
        }),
        { code: "DRAFT_EDIT_APPROVAL_INVALID" },
      );
      await assert.rejects(
        requestShiftDraftEditInternal(pool, {
          ...baseEdit,
          expectedRevision: 1,
        }),
        { code: "DRAFT_EDIT_APPROVAL_STALE" },
      );

      const [requested, replay] = await Promise.all([
        requestShiftDraftEditInternal(pool, baseEdit),
        requestShiftDraftEditInternal(pool, baseEdit),
      ]);
      assert.deepEqual(replay, requested);
      assert.equal(requested.status, "pending");
      assert.equal(requested.policyRevision, 0);
      await assert.rejects(
        requestShiftDraftEditInternal(pool, {
          ...baseEdit,
          endAt: "2027-07-12T14:00:00Z",
        }),
        { code: "DRAFT_EDIT_APPROVAL_KEY_REUSED" },
      );
      const pendingShift = await pool.query<{
        active: boolean;
        draft_revision: number;
        start_at: Date;
      }>(
        `SELECT active,draft_revision,start_at
           FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, shift],
      );
      assert.equal(pendingShift.rows[0]?.active, false);
      assert.equal(pendingShift.rows[0]?.draft_revision, 0);
      assert.equal(
        pendingShift.rows[0]?.start_at.toISOString(),
        "2027-07-12T10:00:00.000Z",
      );

      const review = {
        actor: ownerActor,
        requestId: requested.requestId,
        action: "approve" as const,
        idempotencyKey: "approve-first-edit",
      };
      await assert.rejects(
        reviewShiftDraftEditInternal(
          pool,
          { ...review, actor: managerActor },
          allow,
        ),
        { code: "SCHEDULE_APPROVAL_OWNER_REQUIRED" },
      );
      await assert.rejects(
        reviewShiftDraftEditInternal(pool, review, async () => {
          throw new Error("external approval still required");
        }),
        { code: "DRAFT_POLICY_DENIED" },
      );

      // Inject after protected draft UPDATE/audit/outbox: the approval's
      // final outbox fails, rolling back all state + decision together.
      const poisonId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
           (id,tenant_id,dedupe_key,topic,payload,fingerprint,max_attempts)
         VALUES ($1::uuid,$2::uuid,$3,'schedule.draft.edit.applied',
                 '{"synthetic":true}'::jsonb,repeat('f',64),5)`,
        [poisonId, tenant, `schedule.draft.edit.applied:${requested.requestId}`],
      );
      await assert.rejects(
        reviewShiftDraftEditInternal(pool, review, allow),
        /Outbox idempotency key reused/,
      );
      const afterFailed = await pool.query<{
        status: string;
        draft_revision: number;
        audits: string;
        receipts: string;
      }>(
        `SELECT req.status,shift.draft_revision,
            (SELECT count(*)::text FROM cookie_scheduling.shift_draft_audit
             WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
               AND operation='edit') AS audits,
            (SELECT count(*)::text FROM cookie_scheduling.shift_draft_receipts
             WHERE tenant_id=$1::uuid AND shift_id=$2::uuid
               AND operation='edit') AS receipts
         FROM cookie_scheduling.schedule_draft_edit_requests AS req
         JOIN cookie_scheduling.shift_windows AS shift
           ON shift.tenant_id=req.tenant_id AND shift.id=req.shift_id
        WHERE req.tenant_id=$1::uuid AND req.id=$3::uuid`,
        [tenant, shift, requested.requestId],
      );
      assert.deepEqual(afterFailed.rows[0], {
        status: "pending",
        draft_revision: 0,
        audits: "0",
        receipts: "0",
      });
      await pool.query(
        `DELETE FROM cookie_jobs.outbox_events
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, poisonId],
      );

      const [approved, approvedReplay] = await Promise.all([
        reviewShiftDraftEditInternal(pool, review, allow),
        reviewShiftDraftEditInternal(pool, review, allow),
      ]);
      assert.deepEqual(approved, approvedReplay);
      assert.equal(approved.status, "applied");
      if (approved.status === "applied") {
        assert.equal(approved.editedDraft.revision, 1);
        assert.equal(approved.editedDraft.startAt, "2027-07-12T10:30:00.000Z");
      }
      await assert.rejects(
        reviewShiftDraftEditInternal(
          pool,
          { ...review, idempotencyKey: "attempt-to-reapprove" },
          allow,
        ),
        { code: "DRAFT_EDIT_APPROVAL_ALREADY_DECIDED" },
      );

      // If someone edits the draft independently while an owner review is
      // pending, the original request cannot be approved as if unchanged.
      const stale = await requestShiftDraftEditInternal(pool, {
        ...baseEdit,
        expectedRevision: 1,
        startAt: "2027-07-12T11:00:00Z",
        endAt: "2027-07-12T14:00:00Z",
        idempotencyKey: "stale-pending-edit",
      });
      const independent = await editShiftDraftInternal(
        pool,
        {
          actor: ownerActor,
          shiftId: shift,
          expectedRevision: 1,
          startAt: "2027-07-12T10:45:00Z",
          endAt: "2027-07-12T13:30:00Z",
          idempotencyKey: "trusted-independent-edit",
        },
        allow,
      );
      assert.equal(independent.revision, 2);
      await assert.rejects(
        reviewShiftDraftEditInternal(
          pool,
          {
            ...review,
            requestId: stale.requestId,
            idempotencyKey: "approve-stale-version",
          },
          allow,
        ),
        { code: "DRAFT_EDIT_APPROVAL_STALE" },
      );

      const policy = await setScheduleEditPolicyInternal(pool, {
        actor: ownerActor,
        mode: "direct",
        expectedRevision: 0,
      });
      assert.equal(policy.revision, 1);
      await assert.rejects(
        reviewShiftDraftEditInternal(
          pool,
          {
            ...review,
            requestId: stale.requestId,
            idempotencyKey: "approve-obsolete-policy",
          },
          allow,
        ),
        { code: "DRAFT_EDIT_APPROVAL_STALE" },
      );
      await assert.rejects(
        requestShiftDraftEditInternal(pool, {
          ...baseEdit,
          expectedRevision: 2,
          idempotencyKey: "cannot-request-in-direct",
        }),
        { code: "DRAFT_EDIT_APPROVAL_NOT_ENABLED" },
      );
      const directEdit = await editShiftDraftDirectInternal(
        pool,
        {
          ...baseEdit,
          expectedRevision: 2,
          startAt: "2027-07-12T11:00:00Z",
          endAt: "2027-07-12T13:30:00Z",
          idempotencyKey: "direct-enabled-edit",
        },
        allow,
      );
      assert.equal(directEdit.revision, 3);
      const rejected = await reviewShiftDraftEditInternal(
        pool,
        {
          actor: ownerActor,
          requestId: stale.requestId,
          action: "reject",
          idempotencyKey: "reject-old-draft-edit",
        },
        allow,
      );
      assert.equal(rejected.status, "rejected");
      assert.deepEqual(
        await reviewShiftDraftEditInternal(
          pool,
          {
            actor: ownerActor,
            requestId: stale.requestId,
            action: "reject",
            idempotencyKey: "reject-old-draft-edit",
          },
          allow,
        ),
        rejected,
      );

      const restored = await setScheduleEditPolicyInternal(pool, {
        actor: ownerActor,
        mode: "approval",
        expectedRevision: 1,
      });
      assert.equal(restored.revision, 2);
      await assert.rejects(
        editShiftDraftDirectInternal(
          pool,
          {
            ...baseEdit,
            expectedRevision: 3,
            idempotencyKey: "direct-denied-after-policy",
          },
          allow,
        ),
        { code: "DRAFT_POLICY_DENIED" },
      );
      const secondShift = await makeDraft(13);
      const revoked = await requestShiftDraftEditInternal(pool, {
        actor: managerActor,
        shiftId: secondShift,
        expectedRevision: 0,
        startAt: "2027-07-13T10:30:00Z",
        endAt: "2027-07-13T13:00:00Z",
        idempotencyKey: "edit-request-then-revoke",
      });
      await pool.query(
        `UPDATE cookie_identity.role_assignments SET active=false
          WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenant, manager],
      );
      await assert.rejects(
        reviewShiftDraftEditInternal(
          pool,
          {
            ...review,
            requestId: revoked.requestId,
            idempotencyKey: "approve-after-role-revocation",
          },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );

      const counts = await pool.query<{
        requests: string;
        applied_events: string;
        draft_edits: string;
        draft_edit_receipts: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_scheduling.schedule_draft_edit_requests
           WHERE tenant_id=$1::uuid) AS requests,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
           WHERE tenant_id=$1::uuid AND topic='schedule.draft.edit.applied')
            AS applied_events,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_audit
           WHERE tenant_id=$1::uuid AND operation='edit') AS draft_edits,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_receipts
           WHERE tenant_id=$1::uuid AND operation='edit') AS draft_edit_receipts`,
        [tenant],
      );
      assert.deepEqual(counts.rows[0], {
        requests: "3",
        applied_events: "1",
        draft_edits: "3",
        draft_edit_receipts: "3",
      });
    } finally {
      const tables = [
        "cookie_scheduling.schedule_draft_edit_requests",
        "cookie_scheduling.schedule_publish_requests",
        "cookie_scheduling.schedule_disable_requests",
        "cookie_scheduling.schedule_edit_requests",
        "cookie_scheduling.schedule_edit_policy_audit",
        "cookie_scheduling.schedule_edit_policies",
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
          [[tenant, foreignTenant]],
        )
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [[owner, manager, outsider]],
        )
        .catch(() => undefined);
      await pool.end();
    }
  },
);
