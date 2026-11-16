import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  createShiftDraftDirectInternal,
  requestShiftDraftCreateInternal,
  reviewShiftDraftCreateInternal,
} from "../../../packages/domain-scheduling/src/approval-draft-create.js";
import { setScheduleEditPolicyInternal } from "../../../packages/domain-scheduling/src/approval.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "owner-approved creation is inert until review and atomic under PostgreSQL failures",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-draft-create-approval-synthetic-test",
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
      correlationId: "synthetic-create-review-owner",
    };
    const managerActor = {
      tenantId: tenant,
      identityId: manager,
      correlationId: "synthetic-create-request-manager",
    };
    const allow = async (): Promise<void> => undefined;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid),($3::uuid)",
        [owner, manager, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$3::uuid,'Synthetic create approval'),
                ($2::uuid,$3::uuid,'Synthetic other organization')`,
        [tenant, foreignTenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'Synthetic UTC branch','UTC')`,
        [tenant, location],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid),($1::uuid,$4::uuid)`,
        [tenant, owner, manager, outsider],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions)
         VALUES ($1::uuid,$2::uuid,'owner','Synthetic owner',ARRAY['schedule.manage']),
                ($1::uuid,$3::uuid,'admin','Synthetic manager',ARRAY['schedule.manage'])`,
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
         VALUES ($1::uuid,$2::uuid,'Synthetic staff',true,false)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,true)`,
        [tenant, staff, location],
      );

      const first = {
        actor: managerActor,
        staffId: staff,
        locationId: location,
        startAt: "2027-07-12T10:00:00Z",
        endAt: "2027-07-12T13:00:00Z",
        idempotencyKey: "request-draft-creation-first",
      };
      await assert.rejects(
        createShiftDraftDirectInternal(pool, first, allow),
        { code: "DRAFT_POLICY_DENIED" },
        "unconfigured owner policy must deny direct draft creation",
      );
      await assert.rejects(
        requestShiftDraftCreateInternal(pool, {
          ...first,
          actor: { ...managerActor, tenantId: foreignTenant },
        }),
        { code: "DRAFT_CREATE_APPROVAL_TARGET_UNAVAILABLE" },
      );
      await assert.rejects(
        requestShiftDraftCreateInternal(pool, {
          ...first,
          actor: { ...managerActor, identityId: outsider },
        }),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        requestShiftDraftCreateInternal(pool, {
          ...first,
          startAt: "2027-07-12T10:15:30Z",
        }),
        { code: "DRAFT_CREATE_APPROVAL_INVALID" },
      );
      await assert.rejects(
        requestShiftDraftCreateInternal(pool, {
          ...first,
          endAt: "2027-07-14T11:00:00Z",
        }),
        { code: "DRAFT_CREATE_APPROVAL_INVALID" },
      );

      const [requested, requestReplay] = await Promise.all([
        requestShiftDraftCreateInternal(pool, first),
        requestShiftDraftCreateInternal(pool, first),
      ]);
      assert.deepEqual(requestReplay, requested);
      assert.equal(requested.status, "pending");
      assert.equal(requested.policyRevision, 0);
      await assert.rejects(
        requestShiftDraftCreateInternal(pool, {
          ...first,
          endAt: "2027-07-12T14:00:00Z",
        }),
        { code: "DRAFT_CREATE_APPROVAL_KEY_REUSED" },
      );
      const before = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM cookie_scheduling.shift_windows
         WHERE tenant_id=$1::uuid`,
        [tenant],
      );
      assert.equal(before.rows[0]?.count, "0");

      const review = {
        actor: ownerActor,
        requestId: requested.requestId,
        action: "approve" as const,
        idempotencyKey: "approve-first-draft-creation",
      };
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          { ...review, actor: managerActor },
          allow,
        ),
        { code: "SCHEDULE_APPROVAL_OWNER_REQUIRED" },
      );
      await assert.rejects(
        reviewShiftDraftCreateInternal(pool, review, async () => {
          throw new Error("external approval policy denied");
        }),
        { code: "DRAFT_POLICY_DENIED" },
      );

      // Simulate a late outbox failure AFTER the internal creation inserts
      // shift, audit, command receipt, and created event.
      const poisonId = randomUUID();
      await pool.query(
        `INSERT INTO cookie_jobs.outbox_events
          (id,tenant_id,dedupe_key,topic,payload,fingerprint,max_attempts)
         VALUES ($1::uuid,$2::uuid,$3,'schedule.draft.create.applied',
                 '{"synthetic":true}'::jsonb,repeat('f',64),5)`,
        [
          poisonId,
          tenant,
          `schedule.draft.create.applied:${requested.requestId}`,
        ],
      );
      await assert.rejects(
        reviewShiftDraftCreateInternal(pool, review, allow),
        /Outbox idempotency key reused/,
      );
      const rollback = await pool.query<{
        status: string;
        shifts: string;
        audits: string;
        receipts: string;
      }>(
        `SELECT request.status,
          (SELECT count(*)::text FROM cookie_scheduling.shift_windows
           WHERE tenant_id=$1::uuid) AS shifts,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_audit
           WHERE tenant_id=$1::uuid AND operation='create') AS audits,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_receipts
           WHERE tenant_id=$1::uuid AND operation='create') AS receipts
         FROM cookie_scheduling.schedule_draft_create_requests AS request
         WHERE request.tenant_id=$1::uuid AND request.id=$2::uuid`,
        [tenant, requested.requestId],
      );
      assert.deepEqual(rollback.rows[0], {
        status: "pending",
        shifts: "0",
        audits: "0",
        receipts: "0",
      });
      await pool.query(
        `DELETE FROM cookie_jobs.outbox_events
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, poisonId],
      );

      const [applied, appliedReplay] = await Promise.all([
        reviewShiftDraftCreateInternal(pool, review, allow),
        reviewShiftDraftCreateInternal(pool, review, allow),
      ]);
      assert.deepEqual(appliedReplay, applied);
      assert.equal(applied.status, "applied");
      if (applied.status === "applied") {
        assert.equal(applied.createdDraft.active, false);
        assert.equal(applied.createdDraft.revision, 0);
        assert.equal(applied.createdDraft.staffId, staff);
      }
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          { ...review, idempotencyKey: "different-owner-decision" },
          allow,
        ),
        { code: "DRAFT_CREATE_APPROVAL_ALREADY_DECIDED" },
      );

      // Mode change invalidates a pending request; direct mode allows
      // creation. Explicit owner rejection remains possible when stale.
      const obsolete = await requestShiftDraftCreateInternal(pool, {
        ...first,
        startAt: "2027-07-13T10:00:00Z",
        endAt: "2027-07-13T13:00:00Z",
        idempotencyKey: "obsolete-creation-request",
      });
      const direct = await setScheduleEditPolicyInternal(pool, {
        actor: ownerActor,
        mode: "direct",
        expectedRevision: 0,
      });
      assert.equal(direct.revision, 1);
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          {
            ...review,
            requestId: obsolete.requestId,
            idempotencyKey: "obsolete-policy-approval",
          },
          allow,
        ),
        { code: "DRAFT_CREATE_APPROVAL_STALE" },
      );
      await assert.rejects(
        requestShiftDraftCreateInternal(pool, {
          ...first,
          startAt: "2027-07-14T10:00:00Z",
          endAt: "2027-07-14T13:00:00Z",
          idempotencyKey: "request-disabled-in-direct",
        }),
        { code: "DRAFT_CREATE_APPROVAL_NOT_ENABLED" },
      );
      const directResult = await createShiftDraftDirectInternal(
        pool,
        {
          ...first,
          startAt: "2027-07-14T10:00:00Z",
          endAt: "2027-07-14T13:00:00Z",
          idempotencyKey: "direct-created-draft",
        },
        allow,
      );
      assert.equal(directResult.active, false);
      const rejected = await reviewShiftDraftCreateInternal(
        pool,
        {
          actor: ownerActor,
          requestId: obsolete.requestId,
          action: "reject",
          idempotencyKey: "reject-obsolete",
        },
        allow,
      );
      assert.equal(rejected.status, "rejected");
      assert.deepEqual(
        await reviewShiftDraftCreateInternal(
          pool,
          {
            actor: ownerActor,
            requestId: obsolete.requestId,
            action: "reject",
            idempotencyKey: "reject-obsolete",
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
        createShiftDraftDirectInternal(
          pool,
          {
            ...first,
            startAt: "2027-07-15T10:00:00Z",
            endAt: "2027-07-15T13:00:00Z",
            idempotencyKey: "direct-now-blocked",
          },
          allow,
        ),
        { code: "DRAFT_POLICY_DENIED" },
      );

      const revoked = await requestShiftDraftCreateInternal(pool, {
        ...first,
        startAt: "2027-07-15T10:00:00Z",
        endAt: "2027-07-15T13:00:00Z",
        idempotencyKey: "request-before-revocation",
      });
      await pool.query(
        `UPDATE cookie_staff.location_assignments SET active=false
         WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid`,
        [tenant, staff, location],
      );
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          {
            ...review,
            requestId: revoked.requestId,
            idempotencyKey: "apply-after-assignment-revoked",
          },
          allow,
        ),
        { code: "DRAFT_TARGET_UNAVAILABLE" },
      );
      await pool.query(
        `UPDATE cookie_staff.location_assignments SET active=true
         WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid`,
        [tenant, staff, location],
      );
      await pool.query(
        `UPDATE cookie_identity.role_assignments SET active=false
         WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenant, manager],
      );
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          {
            ...review,
            requestId: revoked.requestId,
            idempotencyKey: "apply-after-requester-revoked",
          },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );

      const counts = await pool.query<{
        requests: string;
        created_shifts: string;
        audits: string;
        receipts: string;
        applied_events: string;
        confirmed: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_scheduling.schedule_draft_create_requests
           WHERE tenant_id=$1::uuid) AS requests,
          (SELECT count(*)::text FROM cookie_scheduling.shift_windows
           WHERE tenant_id=$1::uuid AND active=false) AS created_shifts,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_audit
           WHERE tenant_id=$1::uuid AND operation='create') AS audits,
          (SELECT count(*)::text FROM cookie_scheduling.shift_draft_receipts
           WHERE tenant_id=$1::uuid AND operation='create') AS receipts,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
           WHERE tenant_id=$1::uuid AND topic='schedule.draft.create.applied')
             AS applied_events,
          (SELECT count(*)::text FROM cookie_booking.bookings
           WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed`,
        [tenant],
      );
      assert.deepEqual(counts.rows[0], {
        requests: "3",
        created_shifts: "2",
        audits: "2",
        receipts: "2",
        applied_events: "1",
        confirmed: "0",
      });
    } finally {
      const tables = [
        "cookie_scheduling.schedule_draft_create_requests",
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
