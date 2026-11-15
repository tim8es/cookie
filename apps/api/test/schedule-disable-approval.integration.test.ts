import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import {
  disableShiftDirectInternal,
  requestDisableShiftInternal,
  reviewDisableShiftInternal,
} from "../../../packages/domain-scheduling/src/approval-disable.js";
import { setScheduleEditPolicyInternal } from "../../../packages/domain-scheduling/src/approval.js";
import { createShiftDraftInternal } from "../../../packages/domain-scheduling/src/draft-shift.js";
import { publishShiftInternal } from "../../../packages/domain-scheduling/src/publish-shift.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "owner-reviewed shift disable is fail-closed and atomic with booking coverage",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-disable-approval-synthetic-test",
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
    const service = randomUUID();
    const customer = randomUUID();
    const ownerActor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-disable-owner",
    };
    const managerActor = {
      tenantId: tenant,
      identityId: manager,
      correlationId: "synthetic-disable-manager",
    };
    const allow = async (): Promise<void> => undefined;
    let nextKey = 0;
    const makeShift = async (
      startAt: string,
      endAt: string,
    ): Promise<string> => {
      const key = ++nextKey;
      const draft = await createShiftDraftInternal(
        pool,
        {
          actor: ownerActor,
          staffId: staff,
          locationId: location,
          startAt,
          endAt,
          idempotencyKey: `synthetic-disable-draft-${key}`,
        },
        allow,
      );
      await publishShiftInternal(
        pool,
        {
          actor: ownerActor,
          shiftId: draft.shiftId,
          idempotencyKey: `synthetic-disable-publish-${key}`,
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
         VALUES ($1::uuid,$3::uuid,'Synthetic disable approval'),
                ($2::uuid,$3::uuid,'Synthetic foreign org')`,
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

      const shiftA = await makeShift(
        "2027-06-12T10:00:00Z",
        "2027-06-12T14:00:00Z",
      );
      const booking = await createBookingInternal(
        pool,
        {
          actor: ownerActor,
          customerId: customer,
          staffId: staff,
          locationId: location,
          serviceId: service,
          startAt: "2027-06-12T11:00:00Z",
          idempotencyKey: "synthetic-disable-confirmed-booking",
        },
        allow,
      );
      assert.equal(booking.status, "Confirmed");

      await assert.rejects(
        disableShiftDirectInternal(
          pool,
          {
            actor: managerActor,
            shiftId: shiftA,
            idempotencyKey: "default-direct-denied",
          },
          allow,
        ),
        { code: "SHIFT_POLICY_DENIED" },
      );

      const requestInput = {
        actor: managerActor,
        shiftId: shiftA,
        expectedPublishedRevision: 0,
        idempotencyKey: "request-disable-a",
      };
      await assert.rejects(
        requestDisableShiftInternal(pool, {
          ...requestInput,
          actor: { ...managerActor, identityId: outsider },
        }),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        requestDisableShiftInternal(pool, {
          ...requestInput,
          actor: { ...managerActor, tenantId: foreignTenant },
        }),
        { code: "SCHEDULE_DISABLE_REQUEST_NOT_FOUND" },
      );

      const [request, requestReplay] = await Promise.all([
        requestDisableShiftInternal(pool, requestInput),
        requestDisableShiftInternal(pool, requestInput),
      ]);
      assert.deepEqual(requestReplay, request);
      assert.equal(request.status, "pending");
      assert.equal(request.policyRevision, 0);
      await assert.rejects(
        requestDisableShiftInternal(pool, {
          ...requestInput,
          expectedPublishedRevision: 1,
        }),
        { code: "SCHEDULE_DISABLE_KEY_REUSED" },
      );

      const reviewInput = {
        actor: ownerActor,
        requestId: request.requestId,
        action: "approve" as const,
        idempotencyKey: "approve-disable-a",
      };
      await assert.rejects(
        reviewDisableShiftInternal(
          pool,
          { ...reviewInput, actor: managerActor },
          allow,
        ),
        { code: "SCHEDULE_APPROVAL_OWNER_REQUIRED" },
      );
      await assert.rejects(
        reviewDisableShiftInternal(pool, reviewInput, allow),
        { code: "SHIFT_BOOKING_CONFLICT" },
        "Confirmed booking and postbuffer must never be orphaned",
      );
      const beforeAlternative = await pool.query<{
        active: boolean;
        status: string;
      }>(
        `SELECT shift.active,request.status
           FROM cookie_scheduling.shift_windows AS shift
           JOIN cookie_scheduling.schedule_disable_requests AS request
             ON request.tenant_id=shift.tenant_id
            AND request.shift_id=shift.id
          WHERE shift.tenant_id=$1::uuid AND request.id=$2::uuid`,
        [tenant, request.requestId],
      );
      assert.deepEqual(beforeAlternative.rows[0], {
        active: true,
        status: "pending",
      });

      // Another active shift must cover the WHOLE service+postbuffer.
      await makeShift("2027-06-12T09:00:00Z", "2027-06-12T14:00:00Z");

      // Failure AFTER underlying protected disable and its outbox event:
      // both shift state and approval status must rollback.
      const poisonId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
           (id,tenant_id,dedupe_key,topic,payload,fingerprint,max_attempts)
         VALUES ($1::uuid,$2::uuid,$3,'schedule.disable.applied',
           '{"synthetic":true}'::jsonb,repeat('f',64),5)`,
        [poisonId, tenant, `schedule.disable.applied:${request.requestId}`],
      );
      await assert.rejects(
        reviewDisableShiftInternal(pool, reviewInput, allow),
        /Outbox idempotency key reused/,
      );
      const afterFailure = await pool.query<{
        active: boolean;
        status: string;
        audits: string;
      }>(
        `SELECT shift.active,req.status,
          (SELECT count(*)::text FROM cookie_scheduling.shift_disable_audit
             WHERE tenant_id=$1::uuid AND shift_id=$2::uuid) AS audits
         FROM cookie_scheduling.shift_windows AS shift
         JOIN cookie_scheduling.schedule_disable_requests AS req
           ON req.tenant_id=shift.tenant_id AND req.shift_id=shift.id
         WHERE shift.tenant_id=$1::uuid AND req.id=$3::uuid`,
        [tenant, shiftA, request.requestId],
      );
      assert.deepEqual(afterFailure.rows[0], {
        active: true,
        status: "pending",
        audits: "0",
      });
      await pool.query(
        `DELETE FROM cookie_jobs.outbox_events
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, poisonId],
      );

      const [applied, replay] = await Promise.all([
        reviewDisableShiftInternal(pool, reviewInput, allow),
        reviewDisableShiftInternal(pool, reviewInput, allow),
      ]);
      assert.deepEqual(replay, applied);
      assert.equal(applied.status, "applied");
      if (applied.status === "applied") {
        assert.equal(applied.disabledShift.shiftId, shiftA);
        assert.equal(applied.disabledShift.active, false);
      }
      await assert.rejects(
        reviewDisableShiftInternal(
          pool,
          { ...reviewInput, idempotencyKey: "different-decision" },
          allow,
        ),
        { code: "SCHEDULE_DISABLE_ALREADY_DECIDED" },
      );
      const stillBooked = await pool.query<{ status: string }>(
        `SELECT status FROM cookie_booking.bookings
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, booking.bookingId],
      );
      assert.equal(stillBooked.rows[0]?.status, "Confirmed");

      // Pending request from old policy revision cannot be approved after
      // the owner changes the mode. It can still be explicitly rejected.
      const shiftC = await makeShift(
        "2027-06-12T18:00:00Z",
        "2027-06-12T20:00:00Z",
      );
      const obsolete = await requestDisableShiftInternal(pool, {
        ...requestInput,
        shiftId: shiftC,
        idempotencyKey: "request-disable-old-policy",
      });
      const direct = await setScheduleEditPolicyInternal(pool, {
        actor: ownerActor,
        mode: "direct",
        expectedRevision: 0,
      });
      assert.equal(direct.revision, 1);
      await assert.rejects(
        reviewDisableShiftInternal(
          pool,
          {
            ...reviewInput,
            requestId: obsolete.requestId,
            idempotencyKey: "reject-stale-approval",
          },
          allow,
        ),
        { code: "SCHEDULE_DISABLE_REQUEST_STALE" },
      );
      await assert.rejects(
        requestDisableShiftInternal(pool, {
          ...requestInput,
          shiftId: shiftC,
          idempotencyKey: "requests-disabled-direct-mode",
        }),
        { code: "SCHEDULE_DISABLE_APPROVAL_NOT_ENABLED" },
      );
      const shiftB = await makeShift(
        "2027-06-12T15:00:00Z",
        "2027-06-12T17:00:00Z",
      );
      const disabledDirect = await disableShiftDirectInternal(
        pool,
        {
          actor: managerActor,
          shiftId: shiftB,
          idempotencyKey: "direct-disable-in-direct-mode",
        },
        allow,
      );
      assert.equal(disabledDirect.active, false);
      const rejected = await reviewDisableShiftInternal(
        pool,
        {
          actor: ownerActor,
          requestId: obsolete.requestId,
          action: "reject",
          idempotencyKey: "reject-obsolete-request",
        },
        allow,
      );
      assert.equal(rejected.status, "rejected");
      assert.deepEqual(
        await reviewDisableShiftInternal(
          pool,
          {
            actor: ownerActor,
            requestId: obsolete.requestId,
            action: "reject",
            idempotencyKey: "reject-obsolete-request",
          },
          allow,
        ),
        rejected,
      );

      const approvalAgain = await setScheduleEditPolicyInternal(pool, {
        actor: ownerActor,
        mode: "approval",
        expectedRevision: 1,
      });
      assert.equal(approvalAgain.revision, 2);
      await assert.rejects(
        disableShiftDirectInternal(
          pool,
          {
            actor: managerActor,
            shiftId: shiftC,
            idempotencyKey: "direct-blocked-after-mode-change",
          },
          allow,
        ),
        { code: "SHIFT_POLICY_DENIED" },
      );

      // A requester's role can be revoked while the request is pending.
      const revoked = await requestDisableShiftInternal(pool, {
        ...requestInput,
        shiftId: shiftC,
        idempotencyKey: "request-then-revoke",
      });
      await pool.query(
        `UPDATE cookie_identity.role_assignments SET active=false
          WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenant, manager],
      );
      await assert.rejects(
        reviewDisableShiftInternal(
          pool,
          {
            actor: ownerActor,
            requestId: revoked.requestId,
            action: "approve",
            idempotencyKey: "revoked-request-no-approval",
          },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );
      const counts = await pool.query<{
        requests: string;
        applied_events: string;
        disable_audits: string;
        disable_receipts: string;
        confirmed: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_scheduling.schedule_disable_requests
            WHERE tenant_id=$1::uuid) AS requests,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND topic='schedule.disable.applied')
            AS applied_events,
          (SELECT count(*)::text FROM cookie_scheduling.shift_disable_audit
            WHERE tenant_id=$1::uuid) AS disable_audits,
          (SELECT count(*)::text FROM cookie_scheduling.shift_disable_receipts
            WHERE tenant_id=$1::uuid) AS disable_receipts,
          (SELECT count(*)::text FROM cookie_booking.bookings
            WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed`,
        [tenant],
      );
      assert.deepEqual(counts.rows[0], {
        requests: "3",
        applied_events: "1",
        disable_audits: "2",
        disable_receipts: "2",
        confirmed: "1",
      });
    } finally {
      const tables = [
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
