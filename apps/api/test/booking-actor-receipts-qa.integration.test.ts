import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { cancelBookingInternal } from "../../../packages/domain-booking/src/cancel.js";
import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { rescheduleBookingInternal } from "../../../packages/domain-booking/src/reschedule.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface DurableCounts {
  readonly bookings: string;
  readonly confirmed: string;
  readonly cancelled: string;
  readonly receipts: string;
  readonly events: string;
  readonly moveAudit: string;
  readonly cancelAudit: string;
}
interface ReceiptRow {
  readonly actorId: string;
  readonly operation: string;
  readonly bookingId: string;
  readonly keyHash: string;
  readonly requestHash: string;
}

async function counts(pool: Pool, tenantId: string): Promise<DurableCounts> {
  const result = await pool.query<DurableCounts>(
    `SELECT
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid) AS bookings,
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed,
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND status='CancelledByBusiness') AS cancelled,
       (SELECT count(*)::text FROM cookie_booking.command_receipts
        WHERE tenant_id=$1::uuid) AS receipts,
       (SELECT count(*)::text FROM cookie_jobs.outbox_events
        WHERE tenant_id=$1::uuid) AS events,
       (SELECT count(*)::text FROM cookie_booking.time_change_audit
        WHERE tenant_id=$1::uuid) AS "moveAudit",
       (SELECT count(*)::text FROM cookie_booking.booking_state_audit
        WHERE tenant_id=$1::uuid) AS "cancelAudit"`,
    [tenantId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

test(
  "same tenant and same idempotency key isolate Create/Reschedule/Cancel receipts per actor",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-booking-actor-receipts",
      max: 6,
      connectionTimeoutMillis: 5_000,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const manager = randomUUID();
    const ownerRole = randomUUID();
    const managerRole = randomUUID();
    const location = randomUUID();
    const staff = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const actors = [owner, manager].map((identityId) => ({
      tenantId: tenant,
      identityId,
      correlationId: "synthetic-booking-actor-key-isolation",
    }));
    const allow = async (): Promise<void> => undefined;
    const neverReevaluate = async (): Promise<void> => {
      throw new Error("a committed replay must not reevaluate policy");
    };
    const sharedCreateKey = "same-key-for-distinct-actors-create";
    const sharedMoveKey = "same-key-for-distinct-actors-move";
    const sharedCancelKey = "same-key-for-distinct-actors-cancel";

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid),($2::uuid)",
        [owner, manager],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES ($1::uuid,$2::uuid,'Synthetic actor-scoped QA')`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
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
         VALUES
           ($1::uuid,$2::uuid,'owner','Synthetic owner',
            ARRAY['booking.create','booking.reschedule','booking.cancel']),
           ($1::uuid,$3::uuid,'admin','Synthetic manager',
            ARRAY['booking.create','booking.reschedule','booking.cancel'])`,
        [tenant, ownerRole, managerRole],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id,location_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,NULL),
                ($1::uuid,$5::uuid,$6::uuid,$7::uuid,NULL)`,
        [
          tenant,
          randomUUID(),
          owner,
          ownerRole,
          randomUUID(),
          manager,
          managerRole,
        ],
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
         VALUES ($1::uuid,$2::uuid,'QA service',60,10,127500,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
           (tenant_id,id,display_name,active,bookable)
         VALUES ($1::uuid,$2::uuid,'QA staff',true,true)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,true)`,
        [tenant, staff, location],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true)`,
        [tenant, staff, location, service],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,
                 '2028-10-12T09:00:00Z','2028-10-12T19:00:00Z',true)`,
        [tenant, randomUUID(), staff, location],
      );

      const createCommands = actors.map((actor, index) => ({
        actor,
        customerId: customer,
        locationId: location,
        staffId: staff,
        serviceId: service,
        startAt: index === 0 ? "2028-10-12T10:00:00Z" : "2028-10-12T14:00:00Z",
        idempotencyKey: sharedCreateKey,
      }));
      const created = await Promise.all(
        createCommands.map((command) =>
          createBookingInternal(pool, command, allow),
        ),
      );
      assert.equal(created.length, 2);
      assert.notEqual(created[0]?.bookingId, created[1]?.bookingId);
      assert.ok(created.every((receipt) => receipt.status === "Confirmed"));
      assert.ok(created.every((receipt) => receipt.priceKopecks === "127500"));
      const afterCreate = await counts(pool, tenant);
      assert.deepEqual(afterCreate, {
        bookings: "2",
        confirmed: "2",
        cancelled: "0",
        receipts: "2",
        events: "2",
        moveAudit: "0",
        cancelAudit: "0",
      });
      const createReplays = await Promise.all(
        createCommands.map((command) =>
          createBookingInternal(pool, command, neverReevaluate),
        ),
      );
      assert.deepEqual(createReplays, created);
      assert.deepEqual(await counts(pool, tenant), afterCreate);
      await assert.rejects(
        createBookingInternal(
          pool,
          { ...createCommands[0]!, startAt: "2028-10-12T12:00:00Z" },
          allow,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );

      const moveCommands = actors.map((actor, index) => ({
        actor,
        bookingId: created[index]!.bookingId,
        newStartAt:
          index === 0 ? "2028-10-12T11:30:00Z" : "2028-10-12T16:00:00Z",
        idempotencyKey: sharedMoveKey,
      }));
      const moved = await Promise.all(
        moveCommands.map((command) =>
          rescheduleBookingInternal(pool, command, allow),
        ),
      );
      assert.equal(moved.length, 2);
      assert.ok(moved.every((receipt) => receipt.status === "Confirmed"));
      const afterMove = await counts(pool, tenant);
      assert.deepEqual(afterMove, {
        ...afterCreate,
        receipts: "4",
        events: "4",
        moveAudit: "2",
      });
      const moveReplays = await Promise.all(
        moveCommands.map((command) =>
          rescheduleBookingInternal(pool, command, neverReevaluate),
        ),
      );
      assert.deepEqual(moveReplays, moved);
      assert.deepEqual(await counts(pool, tenant), afterMove);
      await assert.rejects(
        rescheduleBookingInternal(
          pool,
          { ...moveCommands[1]!, bookingId: created[0]!.bookingId },
          allow,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );

      const cancelCommands = actors.map((actor, index) => ({
        actor,
        bookingId: created[index]!.bookingId,
        idempotencyKey: sharedCancelKey,
      }));
      const cancelled = await Promise.all(
        cancelCommands.map((command) =>
          cancelBookingInternal(pool, command, allow),
        ),
      );
      assert.equal(cancelled.length, 2);
      assert.ok(
        cancelled.every((receipt) => receipt.status === "CancelledByBusiness"),
      );
      const afterCancel = await counts(pool, tenant);
      assert.deepEqual(afterCancel, {
        ...afterMove,
        confirmed: "0",
        cancelled: "2",
        receipts: "6",
        events: "6",
        cancelAudit: "2",
      });
      const cancelReplays = await Promise.all(
        cancelCommands.map((command) =>
          cancelBookingInternal(pool, command, neverReevaluate),
        ),
      );
      assert.deepEqual(cancelReplays, cancelled);
      assert.deepEqual(await counts(pool, tenant), afterCancel);
      await assert.rejects(
        cancelBookingInternal(
          pool,
          { ...cancelCommands[0]!, bookingId: created[1]!.bookingId },
          allow,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );

      const durable = await pool.query<ReceiptRow>(
        `SELECT actor_identity_id::text AS "actorId", operation,
                booking_id::text AS "bookingId",
                key_sha256 AS "keyHash",
                request_sha256 AS "requestHash"
         FROM cookie_booking.command_receipts
         WHERE tenant_id=$1::uuid`,
        [tenant],
      );
      assert.equal(durable.rows.length, 6);
      for (const operation of [
        "booking.create",
        "booking.reschedule",
        "booking.cancel",
      ]) {
        const rows = durable.rows.filter((row) => row.operation === operation);
        assert.equal(rows.length, 2, operation);
        assert.deepEqual(
          rows.map((row) => row.actorId).sort(),
          [owner, manager].sort(),
        );
        assert.notEqual(rows[0]!.bookingId, rows[1]!.bookingId);
        assert.equal(
          rows[0]!.keyHash,
          rows[1]!.keyHash,
          "the same raw key has the same digest but independent actor scopes",
        );
        assert.notEqual(
          rows[0]!.requestHash,
          rows[1]!.requestHash,
          "the commands have different payloads and separate receipts",
        );
        for (const row of rows) {
          const expectedId =
            row.actorId === owner
              ? created[0]!.bookingId
              : created[1]!.bookingId;
          assert.equal(row.bookingId, expectedId);
        }
      }

      const events = await pool.query<{ topic: string; bookingId: string }>(
        `SELECT topic,payload->>'bookingId' AS "bookingId"
         FROM cookie_jobs.outbox_events WHERE tenant_id=$1::uuid`,
        [tenant],
      );
      assert.equal(events.rows.length, 6);
      for (const topic of [
        "booking.confirmed",
        "booking.rescheduled",
        "booking.cancelled",
      ]) {
        const matching = events.rows.filter((row) => row.topic === topic);
        assert.equal(matching.length, 2);
        assert.deepEqual(
          matching.map((row) => row.bookingId).sort(),
          created.map((row) => row.bookingId).sort(),
        );
      }

      // All three operations remain independently idempotent after
      // cancellation; replays may return historical receipts, never mutate.
      assert.deepEqual(
        await Promise.all(
          createCommands.map((cmd) =>
            createBookingInternal(pool, cmd, neverReevaluate),
          ),
        ),
        created,
      );
      assert.deepEqual(
        await Promise.all(
          moveCommands.map((cmd) =>
            rescheduleBookingInternal(pool, cmd, neverReevaluate),
          ),
        ),
        moved,
      );
      assert.deepEqual(await counts(pool, tenant), afterCancel);
    } finally {
      const tables = [
        "cookie_booking.time_change_audit",
        "cookie_booking.booking_state_audit",
        "cookie_booking.command_receipts",
        "cookie_jobs.outbox_replay_audit",
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
