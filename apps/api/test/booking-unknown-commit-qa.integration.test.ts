import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { cancelBookingInternal } from "../../../packages/domain-booking/src/cancel.js";
import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { rescheduleBookingInternal } from "../../../packages/domain-booking/src/reschedule.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface DurableSnapshot {
  readonly bookings: string;
  readonly confirmed: string;
  readonly cancelled: string;
  readonly createReceipts: string;
  readonly moveReceipts: string;
  readonly cancelReceipts: string;
  readonly createEvents: string;
  readonly moveEvents: string;
  readonly cancelEvents: string;
  readonly moveAudit: string;
  readonly cancelAudit: string;
  readonly startAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly priceKopecks: string | null;
}

/**
 * Models an ambiguous network result AFTER PostgreSQL has accepted COMMIT.
 * The real PostgreSQL COMMIT is awaited, then its acknowledgement is hidden
 * from the command and its connection is destroyed. Subsequent ROLLBACK
 * attempts fail, as they would on an already-disconnected socket.
 *
 * This is a deterministic protocol-boundary simulation, NOT a packet-loss
 * or TCP proxy test. Only the test receives this facade, never production.
 */
function loseFirstCommitAcknowledgement(realPool: Pool): {
  readonly pool: Pool;
  readonly observed: () => number;
} {
  let lost = 0;
  const broken = (): Error =>
    Object.assign(new Error("SYNTHETIC_COMMIT_ACK_LOST"), {
      code: "ECONNRESET",
    });

  const simulated = {
    async connect(): Promise<PoolClient> {
      const physical = await realPool.connect();
      let released = false;
      let disconnected = false;
      const client = {
        async query(sql: string, params?: unknown[]): Promise<unknown> {
          if (disconnected) throw broken();
          const result = await physical.query(sql, params);
          if (sql.trim().toUpperCase() === "COMMIT" && lost === 0) {
            lost++;
            disconnected = true;
            physical.release(true);
            released = true;
            throw broken();
          }
          return result;
        },
        release(): void {
          if (released) return;
          released = true;
          physical.release(disconnected);
        },
      };
      return client as unknown as PoolClient;
    },
  };
  return { pool: simulated as unknown as Pool, observed: () => lost };
}

async function snapshot(
  pool: Pool,
  tenantId: string,
  bookingId?: string,
): Promise<DurableSnapshot> {
  const rows = await pool.query<DurableSnapshot>(
    `SELECT
      (SELECT count(*)::text FROM cookie_booking.bookings
       WHERE tenant_id=$1::uuid) AS bookings,
      (SELECT count(*)::text FROM cookie_booking.bookings
       WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed,
      (SELECT count(*)::text FROM cookie_booking.bookings
       WHERE tenant_id=$1::uuid AND status='CancelledByBusiness') AS cancelled,
      (SELECT count(*)::text FROM cookie_booking.command_receipts
       WHERE tenant_id=$1::uuid AND operation='booking.create') AS "createReceipts",
      (SELECT count(*)::text FROM cookie_booking.command_receipts
       WHERE tenant_id=$1::uuid AND operation='booking.reschedule') AS "moveReceipts",
      (SELECT count(*)::text FROM cookie_booking.command_receipts
       WHERE tenant_id=$1::uuid AND operation='booking.cancel') AS "cancelReceipts",
      (SELECT count(*)::text FROM cookie_jobs.outbox_events
       WHERE tenant_id=$1::uuid AND topic='booking.confirmed') AS "createEvents",
      (SELECT count(*)::text FROM cookie_jobs.outbox_events
       WHERE tenant_id=$1::uuid AND topic='booking.rescheduled') AS "moveEvents",
      (SELECT count(*)::text FROM cookie_jobs.outbox_events
       WHERE tenant_id=$1::uuid AND topic='booking.cancelled') AS "cancelEvents",
      (SELECT count(*)::text FROM cookie_booking.time_change_audit
       WHERE tenant_id=$1::uuid) AS "moveAudit",
      (SELECT count(*)::text FROM cookie_booking.booking_state_audit
       WHERE tenant_id=$1::uuid) AS "cancelAudit",
      (SELECT start_at FROM cookie_booking.bookings
       WHERE tenant_id=$1::uuid AND id=$2::uuid) AS "startAt",
      (SELECT cancelled_at FROM cookie_booking.bookings
       WHERE tenant_id=$1::uuid AND id=$2::uuid) AS "cancelledAt",
      (SELECT price_kopecks_snapshot::text FROM cookie_booking.bookings
       WHERE tenant_id=$1::uuid AND id=$2::uuid) AS "priceKopecks"`,
    [tenantId, bookingId ?? randomUUID()],
  );
  assert.ok(rows.rows[0], "tenant snapshot exists");
  return rows.rows[0];
}

async function committedReceipt(
  pool: Pool,
  tenantId: string,
  operation: "booking.create" | "booking.reschedule" | "booking.cancel",
): Promise<unknown> {
  const rows = await pool.query<{ result: unknown }>(
    `SELECT result FROM cookie_booking.command_receipts
      WHERE tenant_id=$1::uuid AND operation=$2`,
    [tenantId, operation],
  );
  assert.equal(rows.rows.length, 1, "one durable receipt per operation");
  return rows.rows[0]!.result;
}

test(
  "lost COMMIT acknowledgement recovers Create, Reschedule and Cancel by original keys",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-lost-commit-ack",
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const location = randomUUID();
    const staff = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const role = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-lost-commit-ack",
    };
    const createCommand = {
      actor,
      customerId: customer,
      locationId: location,
      staffId: staff,
      serviceId: service,
      startAt: "2027-08-20T10:00:00Z",
      idempotencyKey: "create-retry-after-unknown-commit",
    };
    const pass = async (): Promise<void> => undefined;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES ($1::uuid,$2::uuid,'Synthetic lost ack tenant')`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'QA branch','UTC')`,
        [tenant, location],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES ($1::uuid,$2::uuid,'owner','Synthetic owner',
                 ARRAY['booking.create','booking.reschedule','booking.cancel'])`,
        [tenant, role],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        [tenant, randomUUID(), owner, role],
      );
      await pool.query(
        "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1::uuid,$2::uuid)",
        [tenant, customer],
      );
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,
            post_service_buffer_minutes,base_price_kopecks,active)
         VALUES ($1::uuid,$2::uuid,'QA service',60,10,125000,true)`,
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
                 '2027-08-20T09:00:00Z','2027-08-20T18:00:00Z',true)`,
        [tenant, randomUUID(), staff, location],
      );

      const createFault = loseFirstCommitAcknowledgement(pool);
      await assert.rejects(
        createBookingInternal(createFault.pool, createCommand, pass),
        { code: "ECONNRESET" },
      );
      assert.equal(createFault.observed(), 1);
      let state = await snapshot(pool, tenant);
      assert.deepEqual(
        [
          state.bookings,
          state.confirmed,
          state.createReceipts,
          state.createEvents,
        ],
        ["1", "1", "1", "1"],
        "server commit is durable despite lost acknowledgement",
      );
      const durableCreate = await committedReceipt(
        pool,
        tenant,
        "booking.create",
      );
      const created = await createBookingInternal(
        pool,
        createCommand,
        async () => {
          throw new Error("retry MUST NOT re-evaluate entitlement");
        },
      );
      assert.deepEqual(created, durableCreate);
      assert.deepEqual(await snapshot(pool, tenant), state);
      await assert.rejects(
        createBookingInternal(
          pool,
          { ...createCommand, startAt: "2027-08-20T12:00:00Z" },
          pass,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );

      const moveCommand = {
        actor,
        bookingId: created.bookingId,
        newStartAt: "2027-08-20T13:00:00Z",
        idempotencyKey: "move-retry-after-unknown-commit",
      };
      const moveFault = loseFirstCommitAcknowledgement(pool);
      await assert.rejects(
        rescheduleBookingInternal(moveFault.pool, moveCommand, pass),
        { code: "ECONNRESET" },
      );
      assert.equal(moveFault.observed(), 1);
      state = await snapshot(pool, tenant, created.bookingId);
      assert.deepEqual(
        [
          state.moveReceipts,
          state.moveEvents,
          state.moveAudit,
          state.startAt?.toISOString(),
        ],
        ["1", "1", "1", "2027-08-20T13:00:00.000Z"],
      );
      assert.equal(state.priceKopecks, "125000");
      const durableMove = await committedReceipt(
        pool,
        tenant,
        "booking.reschedule",
      );
      const moved = await rescheduleBookingInternal(
        pool,
        moveCommand,
        async () => {
          throw new Error("retry MUST NOT rerun reschedule policy");
        },
      );
      assert.deepEqual(moved, durableMove);
      assert.deepEqual(await snapshot(pool, tenant, created.bookingId), state);
      await assert.rejects(
        rescheduleBookingInternal(
          pool,
          { ...moveCommand, newStartAt: "2027-08-20T14:00:00Z" },
          pass,
        ),
        { code: "IDEMPOTENCY_KEY_REUSED" },
      );

      const cancelCommand = {
        actor,
        bookingId: created.bookingId,
        idempotencyKey: "cancel-retry-after-unknown-commit",
      };
      const cancelFault = loseFirstCommitAcknowledgement(pool);
      await assert.rejects(
        cancelBookingInternal(cancelFault.pool, cancelCommand, pass),
        { code: "ECONNRESET" },
      );
      assert.equal(cancelFault.observed(), 1);
      state = await snapshot(pool, tenant, created.bookingId);
      assert.deepEqual(
        [
          state.confirmed,
          state.cancelled,
          state.cancelReceipts,
          state.cancelEvents,
          state.cancelAudit,
        ],
        ["0", "1", "1", "1", "1"],
      );
      assert.ok(state.cancelledAt instanceof Date);
      const durableCancel = await committedReceipt(
        pool,
        tenant,
        "booking.cancel",
      );
      const cancelled = await cancelBookingInternal(
        pool,
        cancelCommand,
        async () => {
          throw new Error("retry MUST NOT rerun cancellation policy");
        },
      );
      assert.deepEqual(cancelled, durableCancel);
      assert.deepEqual(await snapshot(pool, tenant, created.bookingId), state);
      await assert.rejects(
        cancelBookingInternal(
          pool,
          { ...cancelCommand, idempotencyKey: "second-cancel-command" },
          pass,
        ),
        { code: "BOOKING_NOT_CONFIRMED" },
      );

      const after = await pool.query<{
        topic: string;
        bookingId: string;
      }>(
        `SELECT topic, payload->>'bookingId' AS "bookingId"
         FROM cookie_jobs.outbox_events
         WHERE tenant_id=$1::uuid ORDER BY topic`,
        [tenant],
      );
      assert.deepEqual(
        after.rows.map((row) => row.topic),
        ["booking.cancelled", "booking.confirmed", "booking.rescheduled"],
      );
      assert.equal(
        after.rows.every((row) => row.bookingId === created.bookingId),
        true,
      );
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
          await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1::uuid`, [
            tenant,
          ]);
        }
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid",
          [tenant],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [owner],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
