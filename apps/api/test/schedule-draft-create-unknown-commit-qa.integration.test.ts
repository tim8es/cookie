import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import {
  requestShiftDraftCreateInternal,
  reviewShiftDraftCreateInternal,
} from "../../../packages/domain-scheduling/src/approval-draft-create.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

/**
 * Deterministically simulate a lost COMMIT response, not a real TCP outage.
 * PostgreSQL commits on the real connection; the facade then destroys that
 * connection and reports ECONNRESET to the command. Retrying uses a fresh
 * connection from the real pool.
 */
function loseCommitAck(realPool: Pool): { pool: Pool; seen: () => number } {
  let intercepted = 0;
  const disconnectedError = (): Error =>
    Object.assign(new Error("SYNTHETIC_COMMIT_ACK_LOST"), {
      code: "ECONNRESET",
    });
  const simulated = {
    async connect(): Promise<PoolClient> {
      const physical = await realPool.connect();
      let disconnected = false;
      let released = false;
      const facade = {
        async query(sql: string, params?: unknown[]): Promise<unknown> {
          if (disconnected) throw disconnectedError();
          const result = await physical.query(sql, params);
          if (sql.trim().toUpperCase() === "COMMIT" && intercepted === 0) {
            intercepted++;
            disconnected = true;
            physical.release(true);
            released = true;
            throw disconnectedError();
          }
          return result;
        },
        release(): void {
          if (released) return;
          released = true;
          physical.release(disconnected);
        },
      };
      return facade as unknown as PoolClient;
    },
  };
  return { pool: simulated as unknown as Pool, seen: () => intercepted };
}

interface StateRow {
  readonly requests: string;
  readonly pending: string;
  readonly applied: string;
  readonly rejected: string;
  readonly shifts: string;
  readonly draftAudit: string;
  readonly draftReceipts: string;
  readonly requestedEvents: string;
  readonly appliedEvents: string;
  readonly rejectedEvents: string;
}

async function snapshot(pool: Pool, tenantId: string): Promise<StateRow> {
  const result = await pool.query<StateRow>(
    `SELECT
       (SELECT count(*)::text FROM cookie_scheduling.schedule_draft_create_requests
        WHERE tenant_id=$1::uuid) AS requests,
       (SELECT count(*)::text FROM cookie_scheduling.schedule_draft_create_requests
        WHERE tenant_id=$1::uuid AND status='pending') AS pending,
       (SELECT count(*)::text FROM cookie_scheduling.schedule_draft_create_requests
        WHERE tenant_id=$1::uuid AND status='applied') AS applied,
       (SELECT count(*)::text FROM cookie_scheduling.schedule_draft_create_requests
        WHERE tenant_id=$1::uuid AND status='rejected') AS rejected,
       (SELECT count(*)::text FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid) AS shifts,
       (SELECT count(*)::text FROM cookie_scheduling.shift_draft_audit
        WHERE tenant_id=$1::uuid AND operation='create') AS "draftAudit",
       (SELECT count(*)::text FROM cookie_scheduling.shift_draft_receipts
        WHERE tenant_id=$1::uuid AND operation='create') AS "draftReceipts",
       (SELECT count(*)::text FROM cookie_jobs.outbox_events
        WHERE tenant_id=$1::uuid AND topic='schedule.draft.create.requested') AS "requestedEvents",
       (SELECT count(*)::text FROM cookie_jobs.outbox_events
        WHERE tenant_id=$1::uuid AND topic='schedule.draft.create.applied') AS "appliedEvents",
       (SELECT count(*)::text FROM cookie_jobs.outbox_events
        WHERE tenant_id=$1::uuid AND topic='schedule.draft.create.rejected') AS "rejectedEvents"`,
    [tenantId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

test(
  "independent QA: lost COMMIT ACK for draft creation request, approval and rejection",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-draft-create-lost-commit-ack",
      max: 6,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const manager = randomUUID();
    const location = randomUUID();
    const staff = randomUUID();
    const ownerRole = randomUUID();
    const managerRole = randomUUID();
    const ownerActor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-qa-owner-lost-ack",
    };
    const managerActor = {
      tenantId: tenant,
      identityId: manager,
      correlationId: "synthetic-qa-manager-lost-ack",
    };
    const pass = async (): Promise<void> => undefined;
    const request = {
      actor: managerActor,
      staffId: staff,
      locationId: location,
      startAt: "2028-07-12T10:00:00Z",
      endAt: "2028-07-12T13:00:00Z",
      idempotencyKey: "qa-first-draft-request-lost-ack",
    };

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid)",
        [owner, manager],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES ($1::uuid,$2::uuid,'Synthetic draft-ack QA')`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations
           (tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'Synthetic UTC branch','UTC')`,
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
         VALUES ($1::uuid,$2::uuid,'owner','QA owner',ARRAY['schedule.manage']),
                ($1::uuid,$3::uuid,'admin','QA manager',ARRAY['schedule.manage'])`,
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
         VALUES ($1::uuid,$2::uuid,'QA staff',true,false)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,true)`,
        [tenant, staff, location],
      );

      const requestFault = loseCommitAck(pool);
      await assert.rejects(
        requestShiftDraftCreateInternal(requestFault.pool, request),
        { code: "ECONNRESET" },
      );
      assert.equal(requestFault.seen(), 1);
      assert.deepEqual(await snapshot(pool, tenant), {
        requests: "1",
        pending: "1",
        applied: "0",
        rejected: "0",
        shifts: "0",
        draftAudit: "0",
        draftReceipts: "0",
        requestedEvents: "1",
        appliedEvents: "0",
        rejectedEvents: "0",
      });

      const stored = await pool.query<{ id: string }>(
        `SELECT id::text FROM cookie_scheduling.schedule_draft_create_requests
         WHERE tenant_id=$1::uuid AND requester_identity_id=$2::uuid`,
        [tenant, manager],
      );
      assert.equal(stored.rowCount, 1);
      const requestId = stored.rows[0]?.id;
      assert.ok(requestId);
      const replayedRequest = await requestShiftDraftCreateInternal(
        pool,
        request,
      );
      assert.equal(replayedRequest.requestId, requestId);
      assert.equal(replayedRequest.status, "pending");
      assert.equal(replayedRequest.policyRevision, 0);
      await assert.rejects(
        requestShiftDraftCreateInternal(pool, {
          ...request,
          endAt: "2028-07-12T14:00:00Z",
        }),
        { code: "DRAFT_CREATE_APPROVAL_KEY_REUSED" },
      );
      assert.equal((await snapshot(pool, tenant)).requestedEvents, "1");

      const approval = {
        actor: ownerActor,
        requestId,
        action: "approve" as const,
        idempotencyKey: "qa-approval-lost-ack",
      };
      const approveFault = loseCommitAck(pool);
      await assert.rejects(
        reviewShiftDraftCreateInternal(approveFault.pool, approval, pass),
        { code: "ECONNRESET" },
      );
      assert.equal(approveFault.seen(), 1);
      const afterApprove = await snapshot(pool, tenant);
      assert.deepEqual(afterApprove, {
        requests: "1",
        pending: "0",
        applied: "1",
        rejected: "0",
        shifts: "1",
        draftAudit: "1",
        draftReceipts: "1",
        requestedEvents: "1",
        appliedEvents: "1",
        rejectedEvents: "0",
      });
      const persisted = await pool.query<{
        status: string;
        applied_receipt: { shiftId: string; active: boolean };
      }>(
        `SELECT status,applied_receipt
         FROM cookie_scheduling.schedule_draft_create_requests
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, requestId],
      );
      assert.equal(persisted.rows[0]?.status, "applied");
      const shiftId = persisted.rows[0]?.applied_receipt?.shiftId;
      assert.ok(shiftId);
      assert.equal(persisted.rows[0]?.applied_receipt?.active, false);
      const approvalReplay = await reviewShiftDraftCreateInternal(
        pool,
        approval,
        async () => {
          throw new Error("Do not rerun business policy on durable replay");
        },
      );
      assert.equal(approvalReplay.status, "applied");
      if (approvalReplay.status === "applied") {
        assert.equal(approvalReplay.createdDraft.shiftId, shiftId);
        assert.equal(approvalReplay.createdDraft.active, false);
      }
      assert.deepEqual(await snapshot(pool, tenant), afterApprove);
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          { ...approval, idempotencyKey: "qa-different-review-key" },
          pass,
        ),
        { code: "DRAFT_CREATE_APPROVAL_ALREADY_DECIDED" },
      );

      const second = await requestShiftDraftCreateInternal(pool, {
        ...request,
        startAt: "2028-07-13T10:00:00Z",
        endAt: "2028-07-13T13:00:00Z",
        idempotencyKey: "qa-second-draft-request",
      });
      const rejection = {
        actor: ownerActor,
        requestId: second.requestId,
        action: "reject" as const,
        idempotencyKey: "qa-rejection-lost-ack",
      };
      const rejectFault = loseCommitAck(pool);
      await assert.rejects(
        reviewShiftDraftCreateInternal(rejectFault.pool, rejection, pass),
        { code: "ECONNRESET" },
      );
      assert.equal(rejectFault.seen(), 1);
      const afterReject = await snapshot(pool, tenant);
      assert.deepEqual(afterReject, {
        requests: "2",
        pending: "0",
        applied: "1",
        rejected: "1",
        shifts: "1",
        draftAudit: "1",
        draftReceipts: "1",
        requestedEvents: "2",
        appliedEvents: "1",
        rejectedEvents: "1",
      });
      assert.deepEqual(
        await reviewShiftDraftCreateInternal(pool, rejection, pass),
        { requestId: second.requestId, status: "rejected" },
      );
      await assert.rejects(
        reviewShiftDraftCreateInternal(
          pool,
          {
            ...rejection,
            action: "approve",
            idempotencyKey: "qa-opposite-review",
          },
          pass,
        ),
        { code: "DRAFT_CREATE_APPROVAL_ALREADY_DECIDED" },
      );
      assert.deepEqual(await snapshot(pool, tenant), afterReject);

      const events = await pool.query<{ topic: string; request_id: string }>(
        `SELECT topic,payload->>'requestId' AS request_id
         FROM cookie_jobs.outbox_events
         WHERE tenant_id=$1::uuid
           AND topic LIKE 'schedule.draft.create.%'`,
        [tenant],
      );
      assert.equal(events.rows.length, 4);
      assert.deepEqual(
        events.rows
          .filter((row) => row.request_id === requestId)
          .map((row) => row.topic)
          .sort(),
        ["schedule.draft.create.applied", "schedule.draft.create.requested"],
      );
      assert.deepEqual(
        events.rows
          .filter((row) => row.request_id === second.requestId)
          .map((row) => row.topic)
          .sort(),
        ["schedule.draft.create.rejected", "schedule.draft.create.requested"],
      );
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
      try {
        for (const table of tables) {
          await pool
            .query("DELETE FROM " + table + " WHERE tenant_id=$1::uuid", [
              tenant,
            ])
            .catch(() => undefined);
        }
        await pool
          .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [
            tenant,
          ])
          .catch(() => undefined);
        await pool
          .query(
            "DELETE FROM cookie_identity.identities WHERE id=ANY($1::uuid[])",
            [[owner, manager]],
          )
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
