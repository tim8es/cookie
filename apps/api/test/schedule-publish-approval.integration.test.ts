import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import {
  publishShiftDirectInternal,
  requestPublishShiftInternal,
  reviewPublishShiftInternal,
} from "../../../packages/domain-scheduling/src/approval-publish.js";
import { setScheduleEditPolicyInternal } from "../../../packages/domain-scheduling/src/approval.js";
import {
  createShiftDraftInternal,
  editShiftDraftInternal,
} from "../../../packages/domain-scheduling/src/draft-shift.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

import {
  approvalSnapshot,
  expectApprovalCommitFailure,
  recoverNewApprovalRequestAfterLostAck,
} from "./approval-commit-fault.js";

test(
  "owner-approved draft publication is atomic and honors current policy and schedule",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-publish-approval-synthetic-test",
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
    const locationA = randomUUID();
    const locationB = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const ownerActor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-publish-owner",
    };
    const managerActor = {
      tenantId: tenant,
      identityId: manager,
      correlationId: "synthetic-publish-manager",
    };
    const allow = async (): Promise<void> => undefined;
    let draftCounter = 0;
    const makeDraft = async (
      locationId: string,
      startAt: string,
      endAt: string,
    ): Promise<string> => {
      const key = ++draftCounter;
      const draft = await createShiftDraftInternal(
        pool,
        {
          actor: ownerActor,
          staffId: staff,
          locationId,
          startAt,
          endAt,
          idempotencyKey: `synthetic-publish-draft-${key}`,
        },
        allow,
      );
      return draft.shiftId;
    };

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        `INSERT INTO cookie_identity.identities(id)
         VALUES($1::uuid),($2::uuid),($3::uuid)`,
        [owner, manager, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'Synthetic publish approval'),
                ($2::uuid,$3::uuid,'Synthetic foreign publish org')`,
        [tenant, foreignTenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'Synthetic A','UTC'),
                ($1::uuid,$3::uuid,'Synthetic B','Europe/Helsinki')`,
        [tenant, locationA, locationB],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid),($1::uuid,$4::uuid)`,
        [tenant, owner, manager, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions)
         VALUES ($1::uuid,$2::uuid,'owner','Synthetic owner',
                 ARRAY['schedule.manage','booking.create']),
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
          locationA,
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
         VALUES ($1::uuid,$2::uuid,$3::uuid,true),
                ($1::uuid,$2::uuid,$4::uuid,true)`,
        [tenant, staff, locationA, locationB],
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
         VALUES ($1::uuid,$2::uuid,$3::uuid,$5::uuid,true),
                ($1::uuid,$2::uuid,$4::uuid,$5::uuid,true)`,
        [tenant, staff, locationA, locationB, service],
      );
      await pool.query(
        `INSERT INTO cookie_customers.customers(tenant_id,id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenant, customer],
      );

      const shiftA = await makeDraft(
        locationA,
        "2027-06-15T10:00:00Z",
        "2027-06-15T14:00:00Z",
      );
      const directInput = {
        actor: managerActor,
        shiftId: shiftA,
        idempotencyKey: "publish-direct-default-denied",
      };
      await assert.rejects(
        publishShiftDirectInternal(pool, directInput, allow),
        { code: "SHIFT_POLICY_DENIED" },
        "approval@0 default refuses unauthorized direct publication",
      );
      await assert.rejects(
        requestPublishShiftInternal(pool, {
          ...directInput,
          expectedDraftRevision: 0,
          actor: { ...managerActor, identityId: outsider },
        }),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        requestPublishShiftInternal(pool, {
          ...directInput,
          expectedDraftRevision: 0,
          actor: { ...managerActor, tenantId: foreignTenant },
        }),
        { code: "SCHEDULE_PUBLISH_REQUEST_NOT_FOUND" },
      );
      await assert.rejects(
        requestPublishShiftInternal(pool, {
          ...directInput,
          expectedDraftRevision: 1,
        }),
        { code: "SCHEDULE_PUBLISH_REQUEST_STALE" },
      );

      const requestInput = {
        actor: managerActor,
        shiftId: shiftA,
        expectedDraftRevision: 0,
        idempotencyKey: "request-publish-a",
      };
      const beforeRequestFault = await approvalSnapshot(pool, tenant);
      await expectApprovalCommitFailure(pool, "abort", (faultPool) =>
        requestPublishShiftInternal(faultPool, requestInput),
      );
      assert.deepEqual(
        await approvalSnapshot(pool, tenant),
        beforeRequestFault,
      );

      const [request, sameRequest] = await Promise.all([
        requestPublishShiftInternal(pool, requestInput),
        requestPublishShiftInternal(pool, requestInput),
      ]);
      assert.deepEqual(request, sameRequest);
      assert.equal(request.status, "pending");
      assert.equal(request.policyRevision, 0);
      const beforeRequestReplay = await approvalSnapshot(pool, tenant, false);
      await expectApprovalCommitFailure(pool, "lose-ack", (faultPool) =>
        requestPublishShiftInternal(faultPool, requestInput),
      );
      assert.deepEqual(
        await requestPublishShiftInternal(pool, requestInput),
        request,
      );
      assert.deepEqual(
        await approvalSnapshot(pool, tenant, false),
        beforeRequestReplay,
      );
      await assert.rejects(
        requestPublishShiftInternal(pool, {
          ...requestInput,
          expectedDraftRevision: 1,
        }),
        { code: "SCHEDULE_PUBLISH_KEY_REUSED" },
      );
      const before = await pool.query<{ active: boolean }>(
        `SELECT active FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, shiftA],
      );
      assert.equal(before.rows[0]?.active, false);

      const review = {
        actor: ownerActor,
        requestId: request.requestId,
        action: "approve" as const,
        idempotencyKey: "owner-approve-publish-a",
      };
      await assert.rejects(
        reviewPublishShiftInternal(
          pool,
          { ...review, actor: managerActor },
          allow,
        ),
        { code: "SCHEDULE_APPROVAL_OWNER_REQUIRED" },
      );
      await assert.rejects(
        reviewPublishShiftInternal(pool, review, async () => {
          throw new Error("synthetic publication policy rejected");
        }),
        { code: "SHIFT_POLICY_DENIED" },
      );

      // Late failure happens AFTER protected publication writes shift state,
      // publish audit/receipt and outbox. All must rollback together.
      const poisonId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
           (id,tenant_id,dedupe_key,topic,payload,fingerprint,max_attempts)
         VALUES ($1::uuid,$2::uuid,$3,'schedule.publish.applied',
           '{"synthetic":true}'::jsonb,repeat('f',64),5)`,
        [poisonId, tenant, `schedule.publish.applied:${request.requestId}`],
      );
      await assert.rejects(
        reviewPublishShiftInternal(pool, review, allow),
        /Outbox idempotency key reused/,
      );
      const afterFailure = await pool.query<{
        active: boolean;
        status: string;
        audits: string;
        receipts: string;
      }>(
        `SELECT shift.active,req.status,
          (SELECT count(*)::text FROM cookie_scheduling.shift_publish_audit
             WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS audits,
          (SELECT count(*)::text FROM cookie_scheduling.shift_publish_receipts
             WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS receipts
         FROM cookie_scheduling.shift_windows AS shift
         JOIN cookie_scheduling.schedule_publish_requests AS req
           ON req.tenant_id=shift.tenant_id AND req.shift_id=shift.id
         WHERE shift.tenant_id=$1::uuid AND req.id=$3::uuid`,
        [tenant, shiftA, request.requestId],
      );
      assert.deepEqual(afterFailure.rows[0], {
        active: false,
        status: "pending",
        audits: "0",
        receipts: "0",
      });
      await pool.query(
        `DELETE FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, poisonId],
      );

      const beforeReviewFault = await approvalSnapshot(pool, tenant);
      await expectApprovalCommitFailure(pool, "abort", (faultPool) =>
        reviewPublishShiftInternal(faultPool, review, allow),
      );
      assert.deepEqual(await approvalSnapshot(pool, tenant), beforeReviewFault);

      const [applied, replay] = await Promise.all([
        reviewPublishShiftInternal(pool, review, allow),
        reviewPublishShiftInternal(pool, review, allow),
      ]);
      assert.deepEqual(replay, applied);
      assert.equal(applied.status, "applied");
      const beforeReviewReplay = await approvalSnapshot(pool, tenant, false);
      await expectApprovalCommitFailure(pool, "lose-ack", (faultPool) =>
        reviewPublishShiftInternal(faultPool, review, allow),
      );
      assert.deepEqual(
        await reviewPublishShiftInternal(pool, review, allow),
        applied,
      );
      assert.deepEqual(
        await approvalSnapshot(pool, tenant, false),
        beforeReviewReplay,
      );
      if (applied.status === "applied") {
        assert.equal(applied.publishedShift.shiftId, shiftA);
        assert.equal(applied.publishedShift.active, true);
      }
      await assert.rejects(
        reviewPublishShiftInternal(
          pool,
          { ...review, idempotencyKey: "different-decision-key" },
          allow,
        ),
        { code: "SCHEDULE_PUBLISH_ALREADY_DECIDED" },
      );
      const booking = await createBookingInternal(
        pool,
        {
          actor: ownerActor,
          customerId: customer,
          staffId: staff,
          locationId: locationA,
          serviceId: service,
          startAt: "2027-06-15T11:00:00Z",
          idempotencyKey: "book-after-owner-approval",
        },
        allow,
      );
      assert.equal(booking.status, "Confirmed");

      // Cross-branch overlap can arise while a request sits pending. The
      // protected publication command must deny at the review boundary.
      const overlapB = await makeDraft(
        locationB,
        "2027-06-15T11:30:00Z",
        "2027-06-15T13:00:00Z",
      );
      const conflictRequest = await recoverNewApprovalRequestAfterLostAck(
        pool,
        tenant,
        "publish",
        (requestPool) =>
          requestPublishShiftInternal(requestPool, {
            actor: ownerActor,
            shiftId: overlapB,
            expectedDraftRevision: 0,
            idempotencyKey: "request-cross-branch",
          }),
      );
      await assert.rejects(
        reviewPublishShiftInternal(
          pool,
          {
            ...review,
            requestId: conflictRequest.requestId,
            idempotencyKey: "review-cross-branch",
          },
          allow,
        ),
        { code: "SHIFT_CROSS_LOCATION_CONFLICT" },
      );
      const blockedStatus = await pool.query<{ status: string }>(
        `SELECT status FROM cookie_scheduling.schedule_publish_requests
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, conflictRequest.requestId],
      );
      assert.equal(blockedStatus.rows[0]?.status, "pending");
      await reviewPublishShiftInternal(
        pool,
        {
          actor: ownerActor,
          requestId: conflictRequest.requestId,
          action: "reject",
          idempotencyKey: "reject-cross-branch",
        },
        allow,
      );

      // Proposed draft interval changed after submission: even with
      // unchanged organization policy the request is stale.
      const editable = await makeDraft(
        locationA,
        "2027-06-16T10:00:00Z",
        "2027-06-16T13:00:00Z",
      );
      const stale = await requestPublishShiftInternal(pool, {
        actor: managerActor,
        shiftId: editable,
        expectedDraftRevision: 0,
        idempotencyKey: "publish-old-draft-revision",
      });
      const changed = await editShiftDraftInternal(
        pool,
        {
          actor: ownerActor,
          shiftId: editable,
          expectedRevision: 0,
          startAt: "2027-06-16T10:30:00Z",
          endAt: "2027-06-16T13:00:00Z",
          idempotencyKey: "change-pending-draft",
        },
        allow,
      );
      assert.equal(changed.revision, 1);
      await assert.rejects(
        reviewPublishShiftInternal(
          pool,
          {
            ...review,
            requestId: stale.requestId,
            idempotencyKey: "stale-draft-review",
          },
          allow,
        ),
        { code: "SCHEDULE_PUBLISH_REQUEST_STALE" },
      );

      const directPolicy = await setScheduleEditPolicyInternal(pool, {
        actor: ownerActor,
        mode: "direct",
        expectedRevision: 0,
      });
      assert.equal(directPolicy.revision, 1);
      await assert.rejects(
        reviewPublishShiftInternal(
          pool,
          {
            ...review,
            requestId: stale.requestId,
            idempotencyKey: "old-mode-review",
          },
          allow,
        ),
        { code: "SCHEDULE_PUBLISH_REQUEST_STALE" },
      );
      await assert.rejects(
        requestPublishShiftInternal(pool, {
          actor: managerActor,
          shiftId: editable,
          expectedDraftRevision: 1,
          idempotencyKey: "no-request-in-direct-mode",
        }),
        { code: "SCHEDULE_PUBLISH_APPROVAL_NOT_ENABLED" },
      );
      const directPublished = await publishShiftDirectInternal(
        pool,
        {
          actor: managerActor,
          shiftId: editable,
          idempotencyKey: "direct-publish-enabled",
        },
        allow,
      );
      assert.equal(directPublished.active, true);
      const rejection = {
        actor: ownerActor,
        requestId: stale.requestId,
        action: "reject" as const,
        idempotencyKey: "reject-old-publish-request",
      };
      const beforeRejection = await approvalSnapshot(pool, tenant);
      await expectApprovalCommitFailure(pool, "abort", (faultPool) =>
        reviewPublishShiftInternal(faultPool, rejection, allow),
      );
      assert.deepEqual(await approvalSnapshot(pool, tenant), beforeRejection);
      await expectApprovalCommitFailure(pool, "lose-ack", (faultPool) =>
        reviewPublishShiftInternal(faultPool, rejection, allow),
      );
      const afterRejection = await approvalSnapshot(pool, tenant, false);
      const rejected = await reviewPublishShiftInternal(pool, rejection, allow);
      assert.equal(rejected.status, "rejected");
      assert.deepEqual(
        await approvalSnapshot(pool, tenant, false),
        afterRejection,
      );
      assert.deepEqual(
        await reviewPublishShiftInternal(
          pool,
          {
            actor: ownerActor,
            requestId: stale.requestId,
            action: "reject",
            idempotencyKey: "reject-old-publish-request",
          },
          allow,
        ),
        rejected,
      );

      const back = await setScheduleEditPolicyInternal(pool, {
        actor: ownerActor,
        mode: "approval",
        expectedRevision: 1,
      });
      assert.equal(back.revision, 2);
      const revocable = await makeDraft(
        locationA,
        "2027-06-17T10:00:00Z",
        "2027-06-17T13:00:00Z",
      );
      await assert.rejects(
        publishShiftDirectInternal(
          pool,
          {
            actor: managerActor,
            shiftId: revocable,
            idempotencyKey: "direct-now-blocked",
          },
          allow,
        ),
        { code: "SHIFT_POLICY_DENIED" },
      );
      const revokedRequest = await requestPublishShiftInternal(pool, {
        actor: managerActor,
        shiftId: revocable,
        expectedDraftRevision: 0,
        idempotencyKey: "request-then-revoke",
      });
      await pool.query(
        `UPDATE cookie_identity.role_assignments SET active=false
          WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenant, manager],
      );
      await assert.rejects(
        reviewPublishShiftInternal(
          pool,
          {
            ...review,
            requestId: revokedRequest.requestId,
            idempotencyKey: "review-after-revoke",
          },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );

      const counts = await pool.query<{
        requests: string;
        applied_events: string;
        published_audits: string;
        published_receipts: string;
        confirmed: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_scheduling.schedule_publish_requests
            WHERE tenant_id=$1::uuid) AS requests,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND topic='schedule.publish.applied')
            AS applied_events,
          (SELECT count(*)::text FROM cookie_scheduling.shift_publish_audit
            WHERE tenant_id=$1::uuid) AS published_audits,
          (SELECT count(*)::text FROM cookie_scheduling.shift_publish_receipts
            WHERE tenant_id=$1::uuid) AS published_receipts,
          (SELECT count(*)::text FROM cookie_booking.bookings
            WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed`,
        [tenant],
      );
      assert.deepEqual(counts.rows[0], {
        requests: "4",
        applied_events: "1",
        published_audits: "2",
        published_receipts: "2",
        confirmed: "1",
      });
    } finally {
      const tables = [
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
