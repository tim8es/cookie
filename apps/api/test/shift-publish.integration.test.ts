import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { disableShiftInternal } from "../../../packages/domain-scheduling/src/disable-shift.js";
import {
  publishShiftInternal,
  type InternalPublishShift,
} from "../../../packages/domain-scheduling/src/publish-shift.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "draft shift publication enforces authorization, cross-branch windows and serializes publication",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-publish-shift-synthetic-test",
      max: 8,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const outsider = randomUUID();
    const role = randomUUID();
    const staff = randomUUID();
    const customer = randomUUID();
    const service = randomUUID();
    const branchA = randomUUID();
    const branchB = randomUUID();
    const draftA = randomUUID();
    const inactiveOverlap = randomUUID();
    const activeB = randomUUID();
    const branchBOverlap = randomUUID();
    const draftAContest = randomUUID();
    const draftBContest = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-shift-publish",
    };
    const command: InternalPublishShift = {
      actor,
      shiftId: draftA,
      idempotencyKey: "publish-draft-a",
    };
    const allow = async (): Promise<void> => undefined;
    const create = (idempotencyKey: string, startAt: string) =>
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
         VALUES ($1::uuid,$2::uuid,'Synthetic shift publishing')`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'A','UTC'),
                ($1::uuid,$3::uuid,'B','UTC')`,
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
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES
           ($1::uuid,$2::uuid,$9::uuid,$10::uuid,
             '2027-04-12T13:00:00Z','2027-04-12T15:00:00Z',false),
           ($1::uuid,$3::uuid,$9::uuid,$11::uuid,
             '2027-04-12T10:30:00Z','2027-04-12T11:30:00Z',false),
           ($1::uuid,$4::uuid,$9::uuid,$11::uuid,
             '2027-04-12T10:00:00Z','2027-04-12T11:00:00Z',true),
           ($1::uuid,$5::uuid,$9::uuid,$11::uuid,
             '2027-04-12T13:30:00Z','2027-04-12T15:30:00Z',false),
           ($1::uuid,$6::uuid,$9::uuid,$10::uuid,
             '2027-04-12T16:00:00Z','2027-04-12T17:30:00Z',false),
           ($1::uuid,$7::uuid,$9::uuid,$11::uuid,
             '2027-04-12T16:30:00Z','2027-04-12T18:00:00Z',false),
           ($1::uuid,$8::uuid,$9::uuid,$10::uuid,
             '2027-04-12T09:00:00Z','2027-04-12T12:00:00Z',true)`,
        [
          tenant,
          draftA,
          inactiveOverlap,
          activeB,
          branchBOverlap,
          draftAContest,
          draftBContest,
          randomUUID(),
          staff,
          branchA,
          branchB,
        ],
      );

      // Draft never exposes availability. No default public publication.
      await assert.rejects(create("draft-slot", "2027-04-12T13:00:00Z"), {
        code: "BOOKING_NOT_AVAILABLE",
      });
      await assert.rejects(
        publishShiftInternal(
          pool,
          { ...command, shiftId: inactiveOverlap, idempotencyKey: "overlap" },
          allow,
        ),
        { code: "SHIFT_CROSS_LOCATION_CONFLICT" },
      );
      await assert.rejects(
        publishShiftInternal(
          pool,
          { ...command, actor: { ...actor, identityId: outsider } },
          allow,
        ),
        { code: "ACCESS_DENIED" },
      );
      await assert.rejects(
        publishShiftInternal(
          pool,
          { ...command, actor: { ...actor, tenantId: randomUUID() } },
          allow,
        ),
        { code: "SHIFT_NOT_FOUND" },
      );
      await assert.rejects(
        publishShiftInternal(pool, command, async () => {
          throw new Error("PUBLICATION_APPROVAL_REQUIRED");
        }),
        { code: "SHIFT_POLICY_DENIED" },
      );
      const stillDraft = await pool.query<{ active: boolean }>(
        `SELECT active FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, draftA],
      );
      assert.equal(stillDraft.rows[0]?.active, false);

      // PostgreSQL returns ROLLBACK to COMMIT on an aborted transaction.
      // The command must not report publication or return that connection
      // to the pool as healthy, and an ordinary same-key retry must work.
      const acknowledgements: string[] = [];
      const faultPool = {
        async connect(): Promise<PoolClient> {
          const physical = await pool.connect();
          return {
            async query(sql: string, params?: unknown[]): Promise<unknown> {
              if (sql === "COMMIT") {
                await assert.rejects(physical.query("SELECT 1 / 0"), {
                  code: "22012",
                });
                const result = await physical.query(sql, params);
                acknowledgements.push(result.command);
                return result;
              }
              return physical.query(sql, params);
            },
            release(discard?: boolean): void {
              acknowledgements.push(discard ? "discard" : "reuse");
              physical.release(discard);
            },
          } as unknown as PoolClient;
        },
      } as unknown as Pool;
      await assert.rejects(
        publishShiftInternal(faultPool, command, allow),
        /SQL transaction did not commit/,
      );
      assert.deepEqual(acknowledgements, ["ROLLBACK", "discard"]);
      const afterAbort = await pool.query(
        `SELECT
           (SELECT active FROM cookie_scheduling.shift_windows
             WHERE tenant_id=$1::uuid AND id=$2::uuid) AS active,
           (SELECT count(*)::int FROM cookie_scheduling.shift_publish_receipts
             WHERE tenant_id=$1::uuid) AS receipts,
           (SELECT count(*)::int FROM cookie_scheduling.shift_publish_audit
             WHERE tenant_id=$1::uuid) AS audits,
           (SELECT count(*)::int FROM cookie_jobs.outbox_events
             WHERE tenant_id=$1::uuid AND topic='schedule.shift.published')
             AS events`,
        [tenant, draftA],
      );
      assert.deepEqual(afterAbort.rows, [
        { active: false, receipts: 0, audits: 0, events: 0 },
      ]);

      let policyCalls = 0;
      const syntheticAllow = async (): Promise<void> => {
        policyCalls++;
      };
      const [published, retry] = await Promise.all([
        publishShiftInternal(pool, command, syntheticAllow),
        publishShiftInternal(pool, command, syntheticAllow),
      ]);
      assert.deepEqual(retry, published);
      assert.deepEqual(published, {
        shiftId: draftA,
        staffId: staff,
        locationId: branchA,
        startAt: "2027-04-12T13:00:00.000Z",
        endAt: "2027-04-12T15:00:00.000Z",
        active: true,
      });
      assert.equal(policyCalls, 1);
      await assert.rejects(
        publishShiftInternal(
          pool,
          { ...command, shiftId: inactiveOverlap },
          syntheticAllow,
        ),
        { code: "SHIFT_KEY_REUSED" },
      );
      await assert.rejects(
        publishShiftInternal(
          pool,
          { ...command, idempotencyKey: "same-shift-new-key" },
          syntheticAllow,
        ),
        { code: "SHIFT_ALREADY_ACTIVE" },
      );
      const confirmed = await create(
        "confirmed-after-publish",
        "2027-04-12T13:00:00Z",
      );
      assert.equal(confirmed.status, "Confirmed");

      // Published A shift now blocks a different-location overlapping draft.
      await assert.rejects(
        publishShiftInternal(
          pool,
          {
            ...command,
            shiftId: branchBOverlap,
            idempotencyKey: "b-after-a",
          },
          syntheticAllow,
        ),
        { code: "SHIFT_CROSS_LOCATION_CONFLICT" },
      );

      // A disabled historical shift cannot be silently republished, even
      // if it originally appeared in synthetic data as already active.
      const disabled = await disableShiftInternal(
        pool,
        {
          actor,
          shiftId: activeB,
          idempotencyKey: "disable-b-before-republish",
        },
        async () => undefined,
      );
      assert.equal(disabled.active, false);
      await assert.rejects(
        publishShiftInternal(
          pool,
          { ...command, shiftId: activeB, idempotencyKey: "republish-b" },
          syntheticAllow,
        ),
        { code: "SHIFT_REACTIVATION_REQUIRES_REVIEW" },
      );

      // Competing publication of overlapping future shifts in branches A/B:
      // same staff row lock guarantees exactly one succeeds.
      const competition = await Promise.allSettled([
        publishShiftInternal(
          pool,
          { ...command, shiftId: draftAContest, idempotencyKey: "race-a" },
          syntheticAllow,
        ),
        publishShiftInternal(
          pool,
          { ...command, shiftId: draftBContest, idempotencyKey: "race-b" },
          syntheticAllow,
        ),
      ]);
      assert.equal(
        competition.filter((item) => item.status === "fulfilled").length,
        1,
      );
      const contenders = await pool.query<{ id: string; active: boolean }>(
        `SELECT id::text, active FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])
          ORDER BY id`,
        [tenant, [draftAContest, draftBContest]],
      );
      assert.equal(contenders.rows.filter((row) => row.active).length, 1);

      const effects = await pool.query<{
        receipts: string;
        audits: string;
        published_events: string;
        disabled_events: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM cookie_scheduling.shift_publish_receipts
            WHERE tenant_id=$1::uuid) AS receipts,
          (SELECT count(*)::text FROM cookie_scheduling.shift_publish_audit
            WHERE tenant_id=$1::uuid) AS audits,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND topic='schedule.shift.published')
              AS published_events,
          (SELECT count(*)::text FROM cookie_jobs.outbox_events
            WHERE tenant_id=$1::uuid AND topic='schedule.shift.disabled')
              AS disabled_events`,
        [tenant],
      );
      assert.deepEqual(effects.rows[0], {
        receipts: "2",
        audits: "2",
        published_events: "2",
        disabled_events: "1",
      });
    } finally {
      const tables = [
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
