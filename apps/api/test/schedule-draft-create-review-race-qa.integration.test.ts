import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  requestShiftDraftCreateInternal,
  reviewShiftDraftCreateInternal,
} from "../../../packages/domain-scheduling/src/approval-draft-create.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "independent QA: draft-create decisions are tenant-isolated and single-winner under review races",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-draft-create-review-race",
      max: 8,
    });
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const locationA = randomUUID();
    const locationB = randomUUID();
    const staffA = randomUUID();
    const staffB = randomUUID();
    const owner = randomUUID();
    const manager = randomUUID();
    const tenants = [tenantA, tenantB];
    const allow = async (): Promise<void> => undefined;
    const actor = (tenantId: string, identityId: string) => ({
      tenantId,
      identityId,
      correlationId: "synthetic-qa-draft-create-race",
    });

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid)",
        [owner, manager],
      );

      // The same identities, role names and idempotency key are deliberately
      // present in both organizations. Tenant isolation must be server-side.
      for (const [tenant, location, staff] of [
        [tenantA, locationA, staffA],
        [tenantB, locationB, staffB],
      ]) {
        const ownerRole = randomUUID();
        const managerRole = randomUUID();
        await pool.query(
          `INSERT INTO cookie_tenancy.organizations
             (id,owner_identity_id,display_name)
           VALUES ($1::uuid,$2::uuid,'Synthetic independent QA')`,
          [tenant, owner],
        );
        await pool.query(
          `INSERT INTO cookie_tenancy.locations
             (tenant_id,id,display_name,time_zone)
           VALUES ($1::uuid,$2::uuid,'Synthetic branch','UTC')`,
          [tenant, location],
        );
        await pool.query(
          `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
           VALUES ($1::uuid,$2::uuid),($1::uuid,$3::uuid)`,
          [tenant, owner, manager],
        );
        await pool.query(
          `INSERT INTO cookie_identity.roles
             (tenant_id,id,base_type,display_name,permissions)
           VALUES ($1::uuid,$2::uuid,'owner','Synthetic owner',ARRAY['schedule.manage']),
                  ($1::uuid,$3::uuid,'admin','Synthetic manager',ARRAY['schedule.manage'])`,
          [tenant, ownerRole, managerRole],
        );
        await pool.query(
          `INSERT INTO cookie_identity.role_assignments
             (tenant_id,id,identity_id,role_id,location_id)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,NULL),
                  ($1::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid)`,
          [
            tenant,
            randomUUID(),
            owner,
            ownerRole,
            randomUUID(),
            manager,
            managerRole,
            location,
          ],
        );
        await pool.query(
          `INSERT INTO cookie_staff.staff_profiles
             (tenant_id,id,display_name,active,bookable)
           VALUES ($1::uuid,$2::uuid,'Synthetic QA staff',true,false)`,
          [tenant, staff],
        );
        await pool.query(
          `INSERT INTO cookie_staff.location_assignments
             (tenant_id,staff_id,location_id,active)
           VALUES ($1::uuid,$2::uuid,$3::uuid,true)`,
          [tenant, staff, location],
        );
      }

      const sharedKey = "independent-qa-same-key-different-tenant";
      const requestAInput = {
        actor: actor(tenantA, manager),
        staffId: staffA,
        locationId: locationA,
        startAt: "2027-07-20T10:00:00Z",
        endAt: "2027-07-20T12:00:00Z",
        idempotencyKey: sharedKey,
      };
      const requestBInput = {
        actor: actor(tenantB, manager),
        staffId: staffB,
        locationId: locationB,
        startAt: "2027-07-20T10:00:00Z",
        endAt: "2027-07-20T12:00:00Z",
        idempotencyKey: sharedKey,
      };
      const [requestA, requestB] = await Promise.all([
        requestShiftDraftCreateInternal(pool, requestAInput),
        requestShiftDraftCreateInternal(pool, requestBInput),
      ]);
      assert.equal(requestA.status, "pending");
      assert.equal(requestB.status, "pending");
      assert.notEqual(requestA.requestId, requestB.requestId);
      assert.deepEqual(
        await requestShiftDraftCreateInternal(pool, requestAInput),
        requestA,
      );

      const before = await pool.query<{ tenant_id: string; shifts: string }>(
        `SELECT tenant.id::text AS tenant_id,
           (SELECT count(*)::text FROM cookie_scheduling.shift_windows
             WHERE tenant_id=tenant.id) AS shifts
         FROM cookie_tenancy.organizations AS tenant
         WHERE tenant.id=ANY($1::uuid[])`,
        [tenants],
      );
      assert.equal(before.rows.length, 2);
      assert.ok(before.rows.every((row) => row.shifts === "0"));

      // This user really is the owner in tenant B; only the request tenant
      // boundary may prevent review of tenant A's random UUID.
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          {
            actor: actor(tenantB, owner),
            requestId: requestA.requestId,
            action: "approve",
            idempotencyKey: "qa-cross-tenant-approval",
          },
          allow,
        ),
        { code: "DRAFT_CREATE_APPROVAL_NOT_FOUND" },
      );
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          {
            actor: actor(tenantA, manager),
            requestId: requestA.requestId,
            action: "approve",
            idempotencyKey: "qa-non-owner-approval",
          },
          allow,
        ),
        { code: "SCHEDULE_APPROVAL_OWNER_REQUIRED" },
      );

      // Both reviewers have valid owner privileges but propose mutually
      // exclusive decisions for ONE request. Exactly one may commit.
      const attempts = [
        {
          actor: actor(tenantA, owner),
          requestId: requestA.requestId,
          action: "approve" as const,
          idempotencyKey: "qa-approve-race",
        },
        {
          actor: actor(tenantA, owner),
          requestId: requestA.requestId,
          action: "reject" as const,
          idempotencyKey: "qa-reject-race",
        },
      ];
      const settled = await Promise.allSettled(
        attempts.map((input) =>
          reviewShiftDraftCreateInternal(pool, input, allow),
        ),
      );
      assert.equal(
        settled.filter((item) => item.status === "fulfilled").length,
        1,
      );
      const winnerIndex = settled.findIndex(
        (item) => item.status === "fulfilled",
      );
      const winner = settled[winnerIndex];
      const loser = settled[1 - winnerIndex];
      assert.ok(winner);
      assert.ok(loser);
      assert.equal(winner.status, "fulfilled");
      assert.equal(loser.status, "rejected");
      if (winner.status !== "fulfilled" || loser.status !== "rejected") {
        throw new Error("Expected exactly one committed owner decision");
      }
      assert.equal(
        (loser.reason as { code?: string }).code,
        "DRAFT_CREATE_APPROVAL_ALREADY_DECIDED",
      );
      const winningInput = attempts[winnerIndex];
      const losingInput = attempts[1 - winnerIndex];
      assert.ok(winningInput);
      assert.ok(losingInput);
      assert.deepEqual(
        await reviewShiftDraftCreateInternal(pool, winningInput, allow),
        winner.value,
        "the winning decision must replay the identical persisted receipt",
      );
      await assert.rejects(
        reviewShiftDraftCreateInternal(pool, losingInput, allow),
        { code: "DRAFT_CREATE_APPROVAL_ALREADY_DECIDED" },
      );

      const observed = await pool.query<{
        status: string;
        shifts: string;
        audit: string;
        receipts: string;
        requested: string;
        applied: string;
        rejected: string;
      }>(
        `SELECT request.status,
           (SELECT count(*)::text FROM cookie_scheduling.shift_windows
            WHERE tenant_id=$1::uuid) AS shifts,
           (SELECT count(*)::text FROM cookie_scheduling.shift_draft_audit
            WHERE tenant_id=$1::uuid AND operation='create') AS audit,
           (SELECT count(*)::text FROM cookie_scheduling.shift_draft_receipts
            WHERE tenant_id=$1::uuid AND operation='create') AS receipts,
           (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND topic='schedule.draft.create.requested') AS requested,
           (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND topic='schedule.draft.create.applied') AS applied,
           (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND topic='schedule.draft.create.rejected') AS rejected
         FROM cookie_scheduling.schedule_draft_create_requests AS request
         WHERE request.tenant_id=$1::uuid AND request.id=$2::uuid`,
        [tenantA, requestA.requestId],
      );
      const isApplied = winner.value.status === "applied";
      assert.deepEqual(observed.rows[0], {
        status: isApplied ? "applied" : "rejected",
        shifts: isApplied ? "1" : "0",
        audit: isApplied ? "1" : "0",
        receipts: isApplied ? "1" : "0",
        requested: "1",
        applied: isApplied ? "1" : "0",
        rejected: isApplied ? "0" : "1",
      });
      if (winner.value.status === "applied") {
        assert.equal(winner.value.createdDraft.active, false);
        assert.equal(winner.value.createdDraft.staffId, staffA);
      }

      // Tenant B's valid pending request must still be independent, and
      // its owner may reject it without creating a shift in either tenant.
      const stateB = await pool.query<{ status: string }>(
        `SELECT status FROM cookie_scheduling.schedule_draft_create_requests
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantB, requestB.requestId],
      );
      assert.equal(stateB.rows[0]?.status, "pending");
      const rejectedB = await reviewShiftDraftCreateInternal(
        pool,
        {
          actor: actor(tenantB, owner),
          requestId: requestB.requestId,
          action: "reject",
          idempotencyKey: "qa-reject-tenant-b",
        },
        allow,
      );
      assert.equal(rejectedB.status, "rejected");
      const afterB = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM cookie_scheduling.shift_windows
         WHERE tenant_id=$1::uuid`,
        [tenantB],
      );
      assert.equal(afterB.rows[0]?.count, "0");
    } finally {
      const childTables = [
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
      for (const table of childTables) {
        await pool
          .query("DELETE FROM " + table + " WHERE tenant_id=ANY($1::uuid[])", [
            tenants,
          ])
          .catch(() => undefined);
      }
      await pool
        .query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=ANY($1::uuid[])",
          [tenants],
        )
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
          [[owner, manager]],
        )
        .catch(() => undefined);
      await pool.end();
    }
  },
);
