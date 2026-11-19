import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import {
  editPublishedShiftDirectInternal,
  requestPublishedShiftEditInternal,
  reviewScheduleEditRequestInternal,
  setScheduleEditPolicyInternal,
} from "../../../packages/domain-scheduling/src/approval.js";
import { createShiftDraftInternal } from "../../../packages/domain-scheduling/src/draft-shift.js";
import { publishShiftInternal } from "../../../packages/domain-scheduling/src/publish-shift.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

import {
  approvalSnapshot,
  expectApprovalCommitFailure,
  recoverAppliedApprovalAfterLostAck,
  recoverNewApprovalRequestAfterLostAck,
} from "./approval-commit-fault.js";

test(
  "owner approval mode applies a booking-safe shift edit atomically",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-approval-synthetic-test",
      max: 8,
    });
    const tenant = randomUUID();
    const foreignTenant = randomUUID();
    const owner = randomUUID();
    const manager = randomUUID();
    const outsider = randomUUID();
    const roleOwner = randomUUID();
    const roleManager = randomUUID();
    const staff = randomUUID();
    const location = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const ownerActor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-owner-review",
    };
    const managerActor = {
      tenantId: tenant,
      identityId: manager,
      correlationId: "synthetic-manager-request",
    };
    const outsiderActor = {
      tenantId: tenant,
      identityId: outsider,
      correlationId: "synthetic-outsider-denied",
    };
    const allow = async (): Promise<void> => undefined;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid),($3::uuid)",
        [owner, manager, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'Synthetic approval tenant'),
                ($2::uuid,$3::uuid,'Synthetic other tenant')`,
        [tenant, foreignTenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations
           (tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'Synthetic branch','UTC')`,
        [tenant, location],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships
           (tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid),
                ($1::uuid,$4::uuid)`,
        [tenant, owner, manager, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES
           ($1::uuid,$2::uuid,'owner','Synthetic owner',
             ARRAY['schedule.manage','booking.create']),
           ($1::uuid,$3::uuid,'admin','Synthetic manager',
             ARRAY['schedule.manage'])`,
        [tenant, roleOwner, roleManager],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id,location_id)
         VALUES
           ($1::uuid,$2::uuid,$4::uuid,$5::uuid,NULL),
           ($1::uuid,$3::uuid,$6::uuid,$7::uuid,$8::uuid)`,
        [
          tenant,
          randomUUID(),
          randomUUID(),
          owner,
          roleOwner,
          manager,
          roleManager,
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
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,
            post_service_buffer_minutes,base_price_kopecks,active)
         VALUES ($1::uuid,$2::uuid,'Synthetic service',60,10,10000,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true)`,
        [tenant, staff, location, service],
      );
      await pool.query(
        `INSERT INTO cookie_customers.customers(tenant_id,id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenant, customer],
      );

      const draft = await createShiftDraftInternal(
        pool,
        {
          actor: ownerActor,
          staffId: staff,
          locationId: location,
          startAt: "2027-05-10T10:00:00Z",
          endAt: "2027-05-10T14:00:00Z",
          idempotencyKey: "approval-draft",
        },
        allow,
      );
      await publishShiftInternal(
        pool,
        {
          actor: ownerActor,
          shiftId: draft.shiftId,
          idempotencyKey: "approval-publish",
        },
        allow,
      );
      const booking = await createBookingInternal(
        pool,
        {
          actor: ownerActor,
          customerId: customer,
          staffId: staff,
          locationId: location,
          serviceId: service,
          startAt: "2027-05-10T11:00:00Z",
          idempotencyKey: "approval-booked",
        },
        allow,
      );
      assert.equal(booking.status, "Confirmed");
      const unsafeDirect = {
        actor: managerActor,
        shiftId: draft.shiftId,
        startAt: "2027-05-10T10:30:00Z",
        endAt: "2027-05-10T14:00:00Z",
        expectedPublishedRevision: 0,
        idempotencyKey: "direct-denied-in-approval",
      };
      await assert.rejects(
        editPublishedShiftDirectInternal(pool, unsafeDirect, allow),
        { code: "PUBLISHED_SHIFT_POLICY_DENIED" },
        "default approval@0 must reject direct edits",
      );

      await assert.rejects(
        setScheduleEditPolicyInternal(pool, {
          actor: managerActor,
          mode: "direct",
          expectedRevision: 0,
        }),
        { code: "SCHEDULE_APPROVAL_OWNER_REQUIRED" },
      );

      const requested = {
        actor: managerActor,
        shiftId: draft.shiftId,
        startAt: "2027-05-10T10:30:00Z",
        endAt: "2027-05-10T14:00:00Z",
        expectedPublishedRevision: 0,
        idempotencyKey: "request-approved-later",
      };
      await assert.rejects(
        requestPublishedShiftEditInternal(pool, {
          ...requested,
          actor: outsiderActor,
        }),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        requestPublishedShiftEditInternal(pool, {
          ...requested,
          actor: { ...managerActor, tenantId: foreignTenant },
        }),
        { code: "SCHEDULE_APPROVAL_REQUEST_NOT_FOUND" },
      );

      const beforeRequestFault = await approvalSnapshot(pool, tenant);
      await expectApprovalCommitFailure(pool, "abort", (faultPool) =>
        requestPublishedShiftEditInternal(faultPool, requested),
      );
      assert.deepEqual(
        await approvalSnapshot(pool, tenant),
        beforeRequestFault,
      );

      const [request, replay] = await Promise.all([
        requestPublishedShiftEditInternal(pool, requested),
        requestPublishedShiftEditInternal(pool, requested),
      ]);
      assert.deepEqual(replay, request);
      assert.equal(request.status, "pending");
      assert.equal(request.policyRevision, 0);
      const beforeRequestReplay = await approvalSnapshot(pool, tenant, false);
      await expectApprovalCommitFailure(pool, "lose-ack", (faultPool) =>
        requestPublishedShiftEditInternal(faultPool, requested),
      );
      assert.deepEqual(
        await requestPublishedShiftEditInternal(pool, requested),
        request,
      );
      assert.deepEqual(
        await approvalSnapshot(pool, tenant, false),
        beforeRequestReplay,
      );
      await assert.rejects(
        requestPublishedShiftEditInternal(pool, {
          ...requested,
          endAt: "2027-05-10T13:00:00Z",
        }),
        { code: "SCHEDULE_APPROVAL_KEY_REUSED" },
      );
      const unchanged = await pool.query<{ start_at: Date }>(
        `SELECT start_at FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, draft.shiftId],
      );
      assert.equal(
        unchanged.rows[0]?.start_at.toISOString(),
        "2027-05-10T10:00:00.000Z",
      );

      const review = {
        actor: ownerActor,
        requestId: request.requestId,
        action: "approve" as const,
        idempotencyKey: "approve-safe",
      };
      await assert.rejects(
        reviewScheduleEditRequestInternal(
          pool,
          { ...review, actor: managerActor },
          allow,
        ),
        { code: "SCHEDULE_APPROVAL_OWNER_REQUIRED" },
      );
      await assert.rejects(
        reviewScheduleEditRequestInternal(pool, review, async () => {
          throw new Error("Synthetic approval policy unavailable");
        }),
        { code: "PUBLISHED_SHIFT_POLICY_DENIED" },
      );

      // Fail AFTER the protected shift editor updates time, writes audit and
      // writes its own outbox, but BEFORE the approval's own outbox commit.
      // A request must remain pending and its shift unchanged on failure.
      const poisonId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
           (id,tenant_id,dedupe_key,topic,payload,fingerprint,max_attempts)
         VALUES ($1::uuid,$2::uuid,$3,'schedule.edit.applied',
           '{"synthetic":true}'::jsonb,repeat('f',64),5)`,
        [poisonId, tenant, `schedule.edit.applied:${request.requestId}`],
      );
      await assert.rejects(
        reviewScheduleEditRequestInternal(pool, review, allow),
        /Outbox idempotency key reused/,
      );
      const afterFailure = await pool.query<{
        status: string;
        edited: string;
        revisions: number;
      }>(
        `SELECT req.status,
            (SELECT count(*)::text FROM cookie_scheduling.shift_edit_audit
             WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS edited,
            shift.published_revision AS revisions
         FROM cookie_scheduling.schedule_edit_requests AS req
         JOIN cookie_scheduling.shift_windows AS shift
           ON shift.tenant_id=req.tenant_id AND shift.id=req.shift_id
         WHERE req.tenant_id=$1::uuid AND req.id=$3::uuid`,
        [tenant, draft.shiftId, request.requestId],
      );
      assert.deepEqual(afterFailure.rows[0], {
        status: "pending",
        edited: "0",
        revisions: 0,
      });
      await pool.query(
        `DELETE FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, poisonId],
      );

      const beforeReviewFault = await approvalSnapshot(pool, tenant);
      await expectApprovalCommitFailure(pool, "abort", (faultPool) =>
        reviewScheduleEditRequestInternal(faultPool, review, allow),
      );
      assert.deepEqual(await approvalSnapshot(pool, tenant), beforeReviewFault);

      const approved = await recoverAppliedApprovalAfterLostAck(
        pool,
        tenant,
        "edit",
        request.requestId,
        (reviewPool) =>
          reviewScheduleEditRequestInternal(reviewPool, review, allow),
      );
      assert.equal(approved.status, "applied");
      const beforeReviewReplay = await approvalSnapshot(pool, tenant, false);
      await expectApprovalCommitFailure(pool, "lose-ack", (faultPool) =>
        reviewScheduleEditRequestInternal(faultPool, review, allow),
      );
      assert.deepEqual(
        await reviewScheduleEditRequestInternal(pool, review, allow),
        approved,
      );
      assert.deepEqual(
        await approvalSnapshot(pool, tenant, false),
        beforeReviewReplay,
      );
      if (approved.status === "applied") {
        assert.equal(approved.editedShift.publishedRevision, 1);
        assert.equal(approved.editedShift.startAt, "2027-05-10T10:30:00.000Z");
      }
      await assert.rejects(
        reviewScheduleEditRequestInternal(
          pool,
          { ...review, idempotencyKey: "different-review-key" },
          allow,
        ),
        { code: "SCHEDULE_APPROVAL_ALREADY_DECIDED" },
      );
      const confirmed = await pool.query<{ status: string }>(
        `SELECT status FROM cookie_booking.bookings
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, booking.bookingId],
      );
      assert.equal(confirmed.rows[0]?.status, "Confirmed");

      // A request with a shorter target than the booked occupied interval
      // is accepted into the queue but can NEVER be applied at review.
      const unsafe = await recoverNewApprovalRequestAfterLostAck(
        pool,
        tenant,
        "edit",
        (requestPool) =>
          requestPublishedShiftEditInternal(requestPool, {
            ...requested,
            startAt: "2027-05-10T10:45:00Z",
            endAt: "2027-05-10T12:00:00Z",
            expectedPublishedRevision: 1,
            idempotencyKey: "unsafe-shorter-shift",
          }),
      );
      await assert.rejects(
        reviewScheduleEditRequestInternal(
          pool,
          {
            ...review,
            requestId: unsafe.requestId,
            idempotencyKey: "reject-unsafe-during-review",
          },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_BOOKING_CONFLICT" },
      );
      const pending = await pool.query<{ status: string }>(
        `SELECT status FROM cookie_scheduling.schedule_edit_requests
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, unsafe.requestId],
      );
      assert.equal(pending.rows[0]?.status, "pending");

      // Mode update requires actual owner and CAS version. Switching to
      // direct invalidates requests with the old policy revision.
      const beforePolicyFault = await approvalSnapshot(pool, tenant);
      await expectApprovalCommitFailure(pool, "abort", (faultPool) =>
        setScheduleEditPolicyInternal(faultPool, {
          actor: ownerActor,
          mode: "direct",
          expectedRevision: 0,
        }),
      );
      assert.deepEqual(await approvalSnapshot(pool, tenant), beforePolicyFault);
      const direct = await setScheduleEditPolicyInternal(pool, {
        actor: ownerActor,
        mode: "direct",
        expectedRevision: 0,
      });
      assert.equal(direct.revision, 1);
      await assert.rejects(
        setScheduleEditPolicyInternal(pool, {
          actor: ownerActor,
          mode: "approval",
          expectedRevision: 0,
        }),
        { code: "SCHEDULE_APPROVAL_MODE_STALE" },
      );
      await assert.rejects(
        reviewScheduleEditRequestInternal(
          pool,
          {
            ...review,
            requestId: unsafe.requestId,
            idempotencyKey: "no-old-mode-approvals",
          },
          allow,
        ),
        { code: "SCHEDULE_APPROVAL_MODE_STALE" },
      );
      await assert.rejects(
        requestPublishedShiftEditInternal(pool, {
          ...requested,
          expectedPublishedRevision: 1,
          idempotencyKey: "request-disabled-in-direct",
        }),
        { code: "SCHEDULE_APPROVAL_NOT_ENABLED" },
      );

      const editedDirect = await editPublishedShiftDirectInternal(
        pool,
        {
          actor: managerActor,
          shiftId: draft.shiftId,
          startAt: "2027-05-10T10:40:00Z",
          endAt: "2027-05-10T14:00:00Z",
          expectedPublishedRevision: 1,
          idempotencyKey: "direct-now-enabled",
        },
        allow,
      );
      assert.equal(editedDirect.publishedRevision, 2);

      // Owner may explicitly reject an obsolete request: no mutation and
      // identical decision replay, regardless of a mode change.
      const rejection = {
        actor: ownerActor,
        requestId: unsafe.requestId,
        action: "reject" as const,
        idempotencyKey: "reject-obsolete",
      };
      const beforeRejection = await approvalSnapshot(pool, tenant);
      await expectApprovalCommitFailure(pool, "abort", (faultPool) =>
        reviewScheduleEditRequestInternal(faultPool, rejection, allow),
      );
      assert.deepEqual(await approvalSnapshot(pool, tenant), beforeRejection);
      await expectApprovalCommitFailure(pool, "lose-ack", (faultPool) =>
        reviewScheduleEditRequestInternal(faultPool, rejection, allow),
      );
      const afterRejection = await approvalSnapshot(pool, tenant, false);
      const rejected = await reviewScheduleEditRequestInternal(
        pool,
        rejection,
        allow,
      );
      assert.equal(rejected.status, "rejected");
      assert.deepEqual(
        await approvalSnapshot(pool, tenant, false),
        afterRejection,
      );
      assert.deepEqual(
        await reviewScheduleEditRequestInternal(
          pool,
          {
            actor: ownerActor,
            requestId: unsafe.requestId,
            action: "reject",
            idempotencyKey: "reject-obsolete",
          },
          allow,
        ),
        rejected,
      );

      const backInput = {
        actor: ownerActor,
        mode: "approval" as const,
        expectedRevision: 1,
      };
      await expectApprovalCommitFailure(pool, "lose-ack", (faultPool) =>
        setScheduleEditPolicyInternal(faultPool, backInput),
      );
      const policyAfterLostAck = await approvalSnapshot(pool, tenant, false);
      await assert.rejects(setScheduleEditPolicyInternal(pool, backInput), {
        code: "SCHEDULE_APPROVAL_MODE_STALE",
      });
      assert.deepEqual(
        await approvalSnapshot(pool, tenant, false),
        policyAfterLostAck,
      );
      await assert.rejects(
        editPublishedShiftDirectInternal(
          pool,
          {
            actor: managerActor,
            shiftId: draft.shiftId,
            startAt: "2027-05-10T10:50:00Z",
            endAt: "2027-05-10T14:00:00Z",
            expectedPublishedRevision: 2,
            idempotencyKey: "direct-blocked-again",
          },
          allow,
        ),
        { code: "PUBLISHED_SHIFT_POLICY_DENIED" },
      );

      // Revoke the manager's role AFTER filing a valid request and BEFORE
      // owner review: status must stay pending, and no shift write occurs.
      const revokedRequest = await requestPublishedShiftEditInternal(pool, {
        ...requested,
        expectedPublishedRevision: 2,
        startAt: "2027-05-10T10:50:00Z",
        idempotencyKey: "revoked-employee-request",
      });
      await pool.query(
        `UPDATE cookie_identity.role_assignments SET active=false
          WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenant, manager],
      );
      await assert.rejects(
        reviewScheduleEditRequestInternal(
          pool,
          {
            ...review,
            requestId: revokedRequest.requestId,
            idempotencyKey: "cannot-approve-revoked",
          },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );

      const counts = await pool.query<{
        policy_audit: string;
        requests: string;
        edit_audit: string;
        edit_receipts: string;
        applied_events: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM cookie_scheduling.schedule_edit_policy_audit
              WHERE tenant_id=$1::uuid) AS policy_audit,
           (SELECT count(*)::text FROM cookie_scheduling.schedule_edit_requests
              WHERE tenant_id=$1::uuid) AS requests,
           (SELECT count(*)::text FROM cookie_scheduling.shift_edit_audit
              WHERE tenant_id=$1::uuid) AS edit_audit,
           (SELECT count(*)::text FROM cookie_scheduling.shift_edit_receipts
              WHERE tenant_id=$1::uuid) AS edit_receipts,
           (SELECT count(*)::text FROM cookie_jobs.outbox_events
              WHERE tenant_id=$1::uuid AND topic='schedule.edit.applied')
                AS applied_events`,
        [tenant],
      );
      assert.deepEqual(counts.rows[0], {
        policy_audit: "2",
        requests: "3",
        edit_audit: "2",
        edit_receipts: "2",
        applied_events: "1",
      });
    } finally {
      const tables = [
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
